import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser } from './helpers.js';
import { auditArgs, auditTargets } from '../server/mcp.js';

let ctx, bob, token;
beforeEach(async () => {
  ctx = await withAdmin();
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  await bob.client.post('/api/projects', { key: 'WEB', name: 'Website' });
  await bob.client.post('/api/issues', { projectKey: 'WEB', title: 'First' });
  token = (await bob.client.post('/api/me/tokens', { name: 'Claude' })).body.token;
});
let id = 0;
async function tool(name, args = {}) {
  const res = await ctx.app.request(
    'http://t.example/mcp',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
    },
    ctx.env,
  );
  const r = (await res.json()).result;
  return r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text);
}

describe('audit helpers', () => {
  it('records long text as a length and fields as names', () => {
    const a = auditArgs({
      key: 'WEB-1',
      body: 'secret plan',
      description: 'x'.repeat(50),
      fields: { status: 'Done', priority: 'high' },
      q: 'y'.repeat(300),
    });
    expect(a).toMatchObject({ key: 'WEB-1', body: '[11 characters]', description: '[50 characters]', fields: ['status', 'priority'] });
    expect(a.q.length).toBeLessThanOrEqual(121);
    expect(JSON.stringify(a)).not.toContain('secret plan');
  });
  it('finds issue keys and the project', () => {
    expect(auditTargets({ key: 'web-2' }, null)).toMatchObject({ keys: ['WEB-2'], project: 'WEB' });
  });
});

describe('MCP audit log', () => {
  it('records arguments, issues, writes and duration; tags the changes', async () => {
    await tool('get_issue', { key: 'WEB-1' });
    await tool('add_comment', { key: 'WEB-1', body: 'Private words here' });
    await tool('log_work', { key: 'WEB-1', hours: 2, note: 'did it' });
    const rows = (await ctx.admin.get('/api/mcp/activity?all=1')).body.calls;
    const c = rows.find((r) => r.tool === 'add_comment');
    expect(c).toMatchObject({ write: true, issueKeys: ['WEB-1'], projectKey: 'WEB', args: { key: 'WEB-1', body: '[18 characters]' } });
    expect(typeof c.durationMs).toBe('number');
    expect(rows.find((r) => r.tool === 'get_issue').write).toBe(false);
    expect(JSON.stringify(rows)).not.toContain('Private words');

    const issue = (await bob.client.get('/api/issues/WEB-1')).body;
    const comments = issue.comments || issue.issue.comments;
    expect(comments.find((x) => x.body === 'Private words here').source).toBe('mcp');
    const worklogs = issue.worklogs || issue.issue.worklogs;
    expect(worklogs[0].source).toBe('mcp');
    // a comment made in the app is not tagged
    await bob.client.post('/api/issues/WEB-1/comments', { body: 'by hand' });
    const again = (await bob.client.get('/api/issues/WEB-1')).body;
    expect((again.comments || again.issue.comments).find((x) => x.body === 'by hand').source ?? null).toBe(null);
  });

  it('stamps the source as it writes: a web change by the same person during an MCP call stays untagged', async () => {
    const p = (await bob.client.get('/api/projects/WEB')).body.project;
    // both at once, by the same person: the old tagging by time window marked the web rows as MCP too
    const [made] = await Promise.all([
      tool('create_issue', { project: 'WEB', title: 'From the assistant' }),
      bob.client.post('/api/issues/WEB-1/comments', { body: 'web comment' }),
      bob.client.patch('/api/issues/WEB-1', { priority: 'high' }),
      bob.client.post('/api/issues/WEB-1/worklogs', { hours: 1 }),
    ]);
    await tool('update_issue', { key: made.created, status: p.statuses[1].name });
    await tool('add_link', { key: made.created, target: 'WEB-1' });
    const web = (await bob.client.get('/api/issues/WEB-1')).body.issue;
    expect(web.comments.map((x) => x.source)).toEqual([null]);
    expect(web.worklogs.map((x) => x.source)).toEqual([null]);
    expect(web.history.map((h) => [h.field, h.source])).toEqual([
      ['created', null],
      ['priority', null],
    ]);
    const ai = (await bob.client.get(`/api/issues/${made.created}`)).body.issue;
    expect(ai.history.map((h) => [h.field, h.source])).toEqual([
      ['created', 'mcp'],
      ['status', 'mcp'],
      ['link', 'mcp'],
    ]);
    const left = await ctx.db.get(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM issue_history WHERE source = 'mcp' AND issue_id <> ?`, [
      ai.id,
    ]);
    expect(left.n).toBe(0);
  });

  it('filters by tool, writes, issue and project, and exports CSV for admins', async () => {
    await tool('get_issue', { key: 'WEB-1' });
    await tool('add_comment', { key: 'WEB-1', body: 'hi' });
    await tool('list_projects');
    const get = async (q) => (await ctx.admin.get(`/api/mcp/activity?all=1&${q}`)).body.calls;
    expect((await get('write=1')).map((r) => r.tool)).toEqual(['add_comment']);
    expect(await get('tool=get_issue')).toHaveLength(1);
    expect(await get('issue=WEB-1')).toHaveLength(2);
    expect(await get('project=WEB')).toHaveLength(2);
    expect(await get('result=error')).toHaveLength(0);
    const csv = await ctx.admin.get('/api/mcp/activity.csv?all=1');
    expect(csv.status).toBe(200);
    expect(String(csv.body)).toContain('add_comment');
    expect(String(csv.body).split('\n')).toHaveLength(4);
    expect((await bob.client.get('/api/mcp/activity.csv?all=1')).status).toBe(403);
  });

  it('validates the retention setting', async () => {
    expect((await ctx.admin.patch('/api/admin/settings', { mcpLogDays: 3 })).status).toBe(400);
    expect((await ctx.admin.patch('/api/admin/settings', { mcpLogDays: 30 })).body.settings.mcpLogDays).toBe(30);
  });

  it('shows AI changes in the admin audit log and tags them in activity', async () => {
    await tool('get_issue', { key: 'WEB-1' });
    await tool('add_comment', { key: 'WEB-1', body: 'hello from AI' });
    await bob.client.post('/api/issues/WEB-1/comments', { body: 'by hand' });
    const entries = (await ctx.admin.get('/api/admin/audit')).body.entries;
    const ai = entries.filter((e) => e.source === 'mcp');
    expect(ai.map((e) => e.action)).toEqual(['ai.add_comment']); // reads stay in AI audit only
    expect(ai[0]).toMatchObject({ actorName: 'Bob', targetName: 'WEB-1', details: { app: expect.any(String), result: 'ok' } });
    expect(JSON.stringify(ai)).not.toContain('hello from AI');
    // a refused call (bad token) is in the audit log too
    await ctx.app.request(
      'http://t.example/mcp',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer apt_wrong' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'get_issue', arguments: {} } }),
      },
      ctx.env,
    );
    const after = (await ctx.admin.get('/api/admin/audit')).body.entries.filter((e) => e.source === 'mcp').map((e) => e.action);
    expect(after).toContain('ai.rejected');

    const items = (await bob.client.get('/api/activity?limit=10')).body.items.filter((i) => i.kind === 'comment');
    expect(items.find((i) => i.body === 'hello from AI').viaAi).toBe(true);
    expect(items.find((i) => i.body === 'by hand').viaAi).toBe(false);
  });
});

describe('audit log filters', () => {
  it('filters by kind, person, action, text and date; pages; exports CSV', async () => {
    await tool('add_comment', { key: 'WEB-1', body: 'from AI' });
    await ctx.admin.patch('/api/admin/settings', { mcpLogDays: 120 });
    const get = async (q) => (await ctx.admin.get(`/api/admin/audit?${q}`)).body;
    const all = (await get('')).entries;
    expect(all.some((e) => e.source === 'mcp') && all.some((e) => !e.source)).toBe(true);
    expect((await get('source=ai')).entries.every((e) => e.source === 'mcp')).toBe(true);
    expect((await get('source=admin')).entries.every((e) => !e.source)).toBe(true);
    expect((await get('action=settings')).entries.map((e) => e.action)).toEqual(['settings.updated']);
    expect((await get(`actor=${bob.id}`)).entries.every((e) => e.actorName === 'Bob')).toBe(true);
    expect((await get('q=web-1')).entries.map((e) => e.action)).toEqual(['ai.add_comment']);
    expect((await get('from=2000-01-01&to=2000-01-02')).entries).toEqual([]);
    const page = await get('limit=1');
    expect(page.entries.length).toBe(1);
    expect(page.more).toBe(true);
    const next = await get(`limit=1&before=${encodeURIComponent(page.nextBefore)}`);
    expect(next.entries[0].id).not.toBe(page.entries[0].id);
    const csv = await ctx.admin.get('/api/admin/audit.csv?source=ai');
    expect(csv.status).toBe(200);
    expect(csv.body.split('\n')[0]).toBe('When,Who,Action,Target,Details,Source');
    expect(csv.body).toContain('ai.add_comment');
    expect(csv.body).not.toContain('settings.updated');
    expect((await bob.client.get('/api/admin/audit.csv')).status).toBe(403);
    expect((await bob.client.get('/api/admin/audit')).status).toBe(403);
  });
});
