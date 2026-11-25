import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser } from './helpers.js';

let ctx, bob, web, ops;
beforeEach(async () => {
  ctx = await withAdmin();
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  web = (await bob.client.post('/api/projects', { key: 'WEB', name: 'Website' })).body.project;
  ops = (await bob.client.post('/api/projects', { key: 'OPS', name: 'Operations' })).body.project;
  await bob.client.post('/api/issues', { projectKey: 'WEB', title: 'Web bug one' });
  await bob.client.post('/api/issues', { projectKey: 'OPS', title: 'Ops server bug' });
});

const req = async (method, path, token, data) => {
  const headers = { authorization: `Bearer ${token}` };
  if (data !== undefined) headers['content-type'] = 'application/json';
  const res = await ctx.app.request(path, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) }, ctx.env);
  return { status: res.status, body: await res.json().catch(() => null) };
};
async function rpc(body, token) {
  const res = await ctx.app.request(
    'http://t.example/mcp',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    },
    ctx.env,
  );
  return { status: res.status, body: res.status === 202 ? null : await res.json() };
}
let id = 0;
const tool = async (token, name, args = {}) => {
  const r = await rpc({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }, token);
  const res = r.body.result;
  return { error: res.isError ? res.content[0].text : null, data: res.isError ? null : JSON.parse(res.content[0].text) };
};
const scopedToken = async (name = 'Web only') =>
  (await bob.client.post('/api/me/tokens', { name, projectIds: [web.id], expiresInDays: 90 })).body.token;

describe('token scopes', () => {
  it('creates a scoped token and lists its scope and status', async () => {
    const r = await bob.client.post('/api/me/tokens', { name: 'Web only', projectIds: [web.id], expiresInDays: 90 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ scope: 'projects', projectIds: [web.id] });
    await bob.client.post('/api/me/tokens', { name: 'Everything' });
    const list = (await bob.client.get('/api/me/tokens')).body.tokens;
    const scoped = list.find((t) => t.name === 'Web only');
    expect(scoped).toMatchObject({ scope: 'projects', status: 'active', projects: [{ id: web.id, key: 'WEB', name: 'Website' }] });
    expect(list.find((t) => t.name === 'Everything')).toMatchObject({ scope: 'all', projects: [], status: 'active' });
  });

  it('refuses a scope with projects you cannot see or an empty list', async () => {
    const carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
    await bob.client.patch('/api/projects/OPS', { visibility: 'private' });
    expect((await carol.client.post('/api/me/tokens', { name: 'x', projectIds: [ops.id] })).status).toBe(400);
    expect((await carol.client.post('/api/me/tokens', { name: 'x', projectIds: [] })).status).toBe(400);
    expect((await carol.client.post('/api/me/tokens', { name: 'x', projectIds: ['nope'] })).status).toBe(400);
  });

  it('limits REST calls to the chosen projects', async () => {
    const t = await scopedToken();
    expect((await req('GET', '/api/projects', t)).body.projects.map((p) => p.key)).toEqual(['WEB']);
    expect((await req('GET', '/api/projects/OPS', t)).status).toBe(404);
    expect((await req('GET', '/api/projects/OPS/sprints', t)).status).toBe(404);
    expect((await req('GET', '/api/issues/OPS-1', t)).status).toBe(404);
    expect((await req('GET', '/api/issues/WEB-1', t)).status).toBe(200);
    const search = await req('GET', '/api/issues?q=bug', t);
    expect(search.body.issues.map((i) => i.key)).toEqual(['WEB-1']);
    expect((await req('GET', '/api/issues?project=OPS', t)).body.total).toBe(0);
    expect((await req('POST', '/api/issues', t, { projectKey: 'OPS', title: 'no' })).status).toBe(404);
    expect((await req('PATCH', '/api/issues/OPS-1', t, { title: 'no' })).status).toBe(404);
    expect((await req('POST', '/api/issues/OPS-1/comments', t, { body: 'no' })).status).toBe(404);
    expect((await req('POST', '/api/issues/WEB-1/links', t, { targetKey: 'OPS-1', type: 'relates' })).status).toBe(404);
    expect((await req('POST', '/api/projects', t, { key: 'NEW', name: 'New' })).status).toBe(403);
    // labels, activity and the dashboard only show the chosen projects
    await bob.client.patch('/api/issues/OPS-1', { labels: ['opslabel'], assigneeId: bob.id });
    await bob.client.patch('/api/issues/WEB-1', { labels: ['weblabel'], assigneeId: bob.id });
    expect((await req('GET', '/api/labels', t)).body.labels).toEqual(['weblabel']);
    const act = (await req('GET', '/api/activity', t)).body.items;
    expect(act.length).toBeGreaterThan(0);
    expect(act.every((x) => x.issue.key.startsWith('WEB-'))).toBe(true);
    const dash = (await req('GET', '/api/dashboard', t)).body;
    expect(dash.assigned.map((i) => i.key)).toEqual(['WEB-1']);
    expect(dash.counts.todo).toBe(1);
    // the same user's session still sees both
    expect((await bob.client.get('/api/issues?q=bug')).body.total).toBe(2);
  });

  it('hides links to issues outside the scope', async () => {
    await bob.client.post('/api/issues/WEB-1/links', { targetKey: 'OPS-1', type: 'blocks' });
    const t = await scopedToken();
    expect((await req('GET', '/api/issues/WEB-1', t)).body.issue.links).toEqual([]);
    expect((await bob.client.get('/api/issues/WEB-1')).body.issue.links).toHaveLength(1);
  });

  it('limits MCP tools to the chosen projects', async () => {
    const t = await scopedToken();
    expect((await tool(t, 'list_projects')).data.map((p) => p.key)).toEqual(['WEB']);
    expect((await tool(t, 'search_issues', { text: 'bug' })).data.issues.map((i) => i.key)).toEqual(['WEB-1']);
    expect((await tool(t, 'get_issue', { key: 'OPS-1' })).error).toBe('Project not found');
    expect((await tool(t, 'create_issue', { project: 'OPS', title: 'no' })).error).toBe('Project not found');
    expect((await tool(t, 'update_issue', { key: 'OPS-1', title: 'no' })).error).toBe('Project not found');
    expect((await tool(t, 'add_comment', { key: 'OPS-1', body: 'no' })).error).toBe('Project not found');
    expect((await tool(t, 'create_issue', { project: 'WEB', title: 'yes' })).data.created).toBe('WEB-2');
  });

  it('tokens without a scope reach every project', async () => {
    const t = (await bob.client.post('/api/me/tokens', { name: 'All' })).body.token;
    expect((await tool(t, 'list_projects')).data.map((p) => p.key).sort()).toEqual(['OPS', 'WEB']);
  });
});

describe('revoke and expiry', () => {
  it('revoked tokens stay listed but stop working', async () => {
    const r = await bob.client.post('/api/me/tokens', { name: 'Old' });
    expect((await req('GET', '/api/me', r.body.token)).status).toBe(200);
    expect((await bob.client.del(`/api/me/tokens/${r.body.id}`)).status).toBe(200);
    const listed = (await bob.client.get('/api/me/tokens')).body.tokens.find((t) => t.id === r.body.id);
    expect(listed).toMatchObject({ status: 'revoked' });
    expect(listed.revokedAt).toBeTruthy();
    expect((await req('GET', '/api/me', r.body.token)).status).toBe(401);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, r.body.token)).status).toBe(401);
  });

  it('shows expired tokens as expired and refuses them', async () => {
    const r = await bob.client.post('/api/me/tokens', { name: 'Short', expiresInDays: 1 });
    await ctx.db.run('UPDATE api_tokens SET expires_at = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), r.body.id]);
    expect((await bob.client.get('/api/me/tokens')).body.tokens[0]).toMatchObject({ status: 'expired' });
    expect((await req('GET', '/api/me', r.body.token)).status).toBe(401);
  });

  it('only active tokens count toward the limit of 10', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await bob.client.post('/api/me/tokens', { name: `t${i}` });
      if (i < 5) await bob.client.del(`/api/me/tokens/${r.body.id}`);
    }
    expect((await bob.client.post('/api/me/tokens', { name: 'more' })).status).toBe(201);
  });
});

describe('MCP activity log', () => {
  it('writes rows for ok, error and rejected calls, never the token', async () => {
    const t = await scopedToken('Claude Code');
    await tool(t, 'list_projects');
    await tool(t, 'get_issue', { key: 'OPS-1' });
    // revoked token: rejected, but the owner is known
    const old = (await bob.client.post('/api/me/tokens', { name: 'Old' })).body;
    await bob.client.del(`/api/me/tokens/${old.id}`);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, old.token)).status).toBe(401);
    // unknown token: rejected, owner unknown
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'otk_' + 'x'.repeat(40))).status).toBe(401);
    // no credential at all (OAuth discovery): not logged
    await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, null);

    const mine = (await bob.client.get('/api/mcp/activity')).body.calls;
    expect(mine.map((r) => r.result).sort()).toEqual(['error', 'ok', 'rejected']);
    const okRow = mine.find((r) => r.result === 'ok');
    expect(okRow).toMatchObject({ tool: 'list_projects', tokenPrefix: t.slice(0, 8), clientName: 'Claude Code', user: { name: 'Bob' } });
    expect(mine.find((r) => r.result === 'error')).toMatchObject({ tool: 'get_issue', error: 'Project not found' });
    expect(mine.find((r) => r.result === 'rejected')).toMatchObject({ error: 'Token revoked', tokenPrefix: old.token.slice(0, 8) });

    const all = await ctx.db.all('SELECT * FROM mcp_calls');
    expect(all).toHaveLength(4);
    expect(all.find((r) => r.user_id === null)).toMatchObject({ error: 'Unknown token', ok: 0 });
    expect(JSON.stringify(all)).not.toContain(t);
    expect(JSON.stringify(all)).not.toContain(old.token);
  });

  it('users see their own calls; admins can see everyone with ?all=1', async () => {
    const carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
    const tb = await scopedToken();
    const tc = (await carol.client.post('/api/me/tokens', { name: 'c' })).body.token;
    await tool(tb, 'my_work');
    await tool(tc, 'my_work');
    expect((await bob.client.get('/api/mcp/activity')).body.calls).toHaveLength(1);
    expect((await carol.client.get('/api/mcp/activity')).body.calls[0].user.name).toBe('Carol');
    expect((await bob.client.get('/api/mcp/activity?all=1')).status).toBe(403);
    expect((await ctx.admin.get('/api/mcp/activity')).body.calls).toHaveLength(0);
    expect((await ctx.admin.get('/api/mcp/activity?all=1')).body.calls).toHaveLength(2);
    expect((await ctx.admin.get(`/api/mcp/activity?all=1&user=${carol.id}`)).body.calls).toHaveLength(1);
    // not readable with a token
    expect((await req('GET', '/api/mcp/activity', tb)).status).toBe(403);
  });
});

describe('new MCP tools', () => {
  it('list_sprints and add_link', async () => {
    const t = (await bob.client.post('/api/me/tokens', { name: 'All' })).body.token;
    const sp = (await bob.client.post('/api/projects/WEB/sprints', { name: 'Sprint A', goal: 'Ship' })).body.sprint;
    await bob.client.post(`/api/sprints/${sp.id}/start`, {});
    await bob.client.post('/api/projects/WEB/sprints', { name: 'Sprint B' });
    const list = (await tool(t, 'list_sprints', { project: 'web' })).data;
    expect(list.map((x) => `${x.name}:${x.state}`).sort()).toEqual(['Sprint A:active', 'Sprint B:future']);
    expect(list.find((x) => x.name === 'Sprint A').goal).toBe('Ship');
    const link = await tool(t, 'add_link', { key: 'WEB-1', target: 'OPS-1', type: 'blocks' });
    expect(link.data).toMatchObject({ ok: true, from: 'WEB-1', type: 'blocks', to: 'OPS-1' });
    const got = (await tool(t, 'get_issue', { key: 'WEB-1' })).data;
    expect(got.links).toEqual([expect.objectContaining({ type: 'blocks', direction: 'out', key: 'OPS-1' })]);
    expect((await tool(t, 'add_link', { key: 'WEB-1', target: 'OPS-1', type: 'blocks' })).error).toContain('already linked');
    // a scoped token cannot list another project's sprints
    const s = await scopedToken();
    expect((await tool(s, 'list_sprints', { project: 'OPS' })).error).toBe('Project not found');
  });
});
