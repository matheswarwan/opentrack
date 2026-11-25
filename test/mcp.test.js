import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser } from './helpers.js';

let ctx, bob, token;
beforeEach(async () => {
  ctx = await withAdmin();
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
  await bob.client.post('/api/projects', { key: 'WEB', name: 'Website' });
  const r = await bob.client.post('/api/me/tokens', { name: 'Claude Code' });
  expect(r.status).toBe(201);
  token = r.body.token;
});

async function rpc(body, auth = `Bearer ${token}`, headers = {}) {
  const res = await ctx.app.request(
    'http://t.example/mcp',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}), ...headers },
      body: JSON.stringify(body),
    },
    ctx.env,
  );
  return { status: res.status, body: res.status === 202 ? null : await res.json() };
}
let id = 0;
const tool = async (name, args = {}) => {
  const r = await rpc({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } });
  const res = r.body.result;
  return { error: res.isError ? res.content[0].text : null, data: res.isError ? null : JSON.parse(res.content[0].text) };
};

describe('API tokens', () => {
  it('lists without the secret, works as bearer, can be revoked', async () => {
    const list = await bob.client.get('/api/me/tokens');
    expect(list.body.tokens[0]).toMatchObject({ name: 'Claude Code', prefix: token.slice(0, 8) });
    expect(JSON.stringify(list.body)).not.toContain(token);
    const me = await ctx.app.request('/api/me', { headers: { authorization: `Bearer ${token}` } }, ctx.env);
    expect((await me.json()).user.name).toBe('Bob');
    // writes with a token need no CSRF header
    const w = await ctx.app.request(
      '/api/issues',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ projectKey: 'WEB', title: 'via token' }),
      },
      ctx.env,
    );
    expect(w.status).toBe(201);
    // a token cannot mint tokens or do admin work
    const mint = await ctx.app.request(
      '/api/me/tokens',
      { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{"name":"x"}' },
      ctx.env,
    );
    expect(mint.status).toBe(403);
    await bob.client.del(`/api/me/tokens/${list.body.tokens[0].id}`);
    const after = await ctx.app.request('/api/me', { headers: { authorization: `Bearer ${token}` } }, ctx.env);
    expect(after.status).toBe(401);
  });

  it('stops working when the user is deactivated or tokens are turned off', async () => {
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(200);
    await ctx.admin.patch('/api/admin/settings', { apiTokens: false });
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
    await ctx.admin.patch('/api/admin/settings', { apiTokens: true });
    await ctx.admin.patch(`/api/admin/users/${bob.id}`, { status: 'deactivated' });
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
  });

  it('admin token cannot use admin routes', async () => {
    const t = (await ctx.admin.post('/api/me/tokens', { name: 'a' })).body.token;
    const r = await ctx.app.request('/api/admin/users', { headers: { authorization: `Bearer ${t}` } }, ctx.env);
    expect(r.status).toBe(403);
  });
});

describe('MCP server', () => {
  it('rejects missing tokens and foreign origins', async () => {
    const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' }, null);
    expect(r.status).toBe(401);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, `Bearer ${token}`, { origin: 'https://evil.example' })).status).toBe(403);
    const get = await ctx.app.request('/mcp', { headers: { authorization: `Bearer ${token}` } }, ctx.env);
    expect(get.status).toBe(405);
  });

  it('initializes and lists tools', async () => {
    const init = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    });
    expect(init.body.result).toMatchObject({
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'opentrack' },
      capabilities: { tools: {} },
    });
    expect(init.body.result.instructions).toContain('Bob');
    expect((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list.body.result.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['search_issues', 'create_issue', 'update_issue', 'add_comment', 'get_issue', 'my_work']),
    );
    expect((await rpc({ jsonrpc: '2.0', id: 3, method: 'nope' })).body.error.code).toBe(-32601);
    const batch = await rpc([
      { jsonrpc: '2.0', id: 4, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
    ]);
    expect(batch.body).toHaveLength(1);
  });

  it('creates, searches, updates, comments and reads issues as the token owner', async () => {
    const created = await tool('create_issue', {
      project: 'web',
      title: 'Fix login',
      type: 'bug',
      assignee: 'carol@example.com',
      labels: ['auth'],
      priority: 'high',
    });
    expect(created.error).toBeNull();
    expect(created.data).toMatchObject({ created: 'WEB-1', assignee: 'Carol', status: 'To Do', priority: 'high' });
    const found = await tool('search_issues', { assignee: 'carol@example.com', status_category: 'open' });
    expect(found.data.issues.map((i) => i.key)).toEqual(['WEB-1']);
    const up = await tool('update_issue', { key: 'WEB-1', status: 'in progress', assignee: 'me' });
    expect(up.data.now).toMatchObject({ status: 'In Progress', assignee: 'Bob' });
    expect((await tool('search_issues', { status: 'In Progress' })).data.total).toBe(1);
    expect((await tool('add_comment', { key: 'WEB-1', body: 'Started on this' })).data.ok).toBe(true);
    expect((await tool('log_work', { key: 'WEB-1', hours: 2, note: 'debugging' })).data.ok).toBe(true);
    const got = await tool('get_issue', { key: 'WEB-1' });
    expect(got.data.comments[0]).toMatchObject({ author: 'Bob', body: 'Started on this' });
    expect(got.data.loggedHours).toBe(2);
    expect(got.data.history.some((h) => h.field === 'status' && h.to === 'In Progress')).toBe(true);
    const mine = await tool('my_work');
    expect(mine.data.assignedToMe[0].key).toBe('WEB-1');
    const projects = await tool('list_projects');
    expect(projects.data[0]).toMatchObject({ key: 'WEB', canEdit: true });
    expect((await tool('list_users', { query: 'car' })).data).toEqual([{ name: 'Carol', email: 'carol@example.com' }]);
  });

  it('returns clear tool errors', async () => {
    expect((await tool('update_issue', { key: 'WEB-99', title: 'x' })).error).toBe('Issue not found');
    await tool('create_issue', { project: 'WEB', title: 'a' });
    expect((await tool('update_issue', { key: 'WEB-1', status: 'Shipped' })).error).toContain('Statuses: To Do, In Progress');
    expect((await tool('create_issue', { project: 'WEB', title: 'a', assignee: 'nobody@example.com' })).error).toContain('list_users');
    expect((await tool('update_issue', { key: 'WEB-1', sprint: 'active' })).error).toContain('No active sprint');
  });

  it('respects project permissions', async () => {
    await bob.client.patch('/api/projects/WEB', { visibility: 'private' });
    const carolLogin = await addUser(ctx, { email: 'dave@example.com', name: 'Dave' });
    const t = (await carolLogin.client.post('/api/me/tokens', { name: 'x' })).body.token;
    const r = await rpc(
      { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'create_issue', arguments: { project: 'WEB', title: 'sneaky' } } },
      `Bearer ${t}`,
    );
    expect(r.body.result.isError).toBe(true);
    expect(r.body.result.content[0].text).toBe('Project not found');
  });
});
