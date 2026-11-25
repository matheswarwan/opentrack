import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser, client, PASSWORD } from './helpers.js';

let ctx, bob, carol, anon;
beforeEach(async () => {
  ctx = await withAdmin({ PUBLIC_URL: 'https://tracker.example.com' });
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
  anon = client(ctx); // no cookie, like Google Sheets
  await bob.client.post('/api/projects', { key: 'web', name: 'Website' });
  await bob.client.post('/api/issues', { projectKey: 'WEB', type: 'epic', title: 'Launch' });
  await bob.client.post('/api/issues', {
    projectKey: 'WEB',
    type: 'story',
    title: '=HYPERLINK("http://evil")',
    parentKey: 'WEB-1',
    assigneeId: carol.id,
    storyPoints: 3,
  });
  await bob.client.post('/api/issues', { projectKey: 'WEB', type: 'subtask', title: 'Sub, with "quotes"', parentKey: 'WEB-2' });
  await carol.client.post('/api/issues/WEB-2/worklogs', { hours: 1.5 });
});

const pathOf = (url) => new URL(url).pathname;
const parseCsv = (text) => text.trim().split('\n');

describe('Google Sheets feeds', () => {
  it('creates a feed, returns the URL once and stores only a hash', async () => {
    const r = await carol.client.post('/api/feeds', {
      name: 'Plan',
      query: { project: 'WEB', sort: 'key', dir: 'asc' },
      columns: ['key', 'title', 'epicKey', 'epicTitle', 'assignee', 'assigneeEmail', 'loggedHours', 'url'],
    });
    expect(r.status).toBe(201);
    expect(r.body.url).toMatch(/^https:\/\/tracker\.example\.com\/feeds\/[A-Za-z0-9_-]{43}\.csv$/);
    expect(r.body.formula).toBe(`=IMPORTDATA("${r.body.url}")`);
    const token = pathOf(r.body.url).slice(7, -4);
    const rows = ctx.db.raw.prepare('SELECT * FROM feeds').all();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0].prefix).toBe(token.slice(0, 6));
    const list = await carol.client.get('/api/feeds');
    expect(list.body.feeds).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(token);
    expect(list.body.feeds[0].lastUsedAt).toBeNull();
    const audit = await ctx.admin.get('/api/admin/audit');
    expect(audit.body.entries.some((e) => e.action === 'feed.created')).toBe(true);
  });

  it('serves CSV with the chosen columns, epics and neutralised formulas', async () => {
    const r = await carol.client.post('/api/feeds', {
      name: 'Plan',
      query: { project: 'WEB', sort: 'key', dir: 'asc' },
      columns: ['key', 'title', 'epicKey', 'epicTitle', 'assignee', 'assigneeEmail', 'loggedHours', 'url'],
    });
    const res = await anon.get(pathOf(r.body.url));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const lines = parseCsv(res.body);
    expect(lines[0]).toBe('Key,Title,Epic key,Epic title,Assignee,Assignee email,Logged hours,URL');
    expect(lines[1]).toBe('WEB-1,Launch,,,,,0,https://tracker.example.com/browse/WEB-1');
    expect(lines[2]).toBe(
      `WEB-2,"'=HYPERLINK(""http://evil"")",WEB-1,Launch,Carol,carol@example.com,1.5,https://tracker.example.com/browse/WEB-2`,
    );
    expect(lines[3]).toBe('WEB-3,"Sub, with ""quotes""",WEB-1,Launch,,,0,https://tracker.example.com/browse/WEB-3');
    expect(lines).toHaveLength(4);
    const list = await carol.client.get('/api/feeds');
    expect(list.body.feeds[0].lastUsedAt).toBeTruthy();
  });

  it('uses the default columns and filters like the search page', async () => {
    const r = await carol.client.post('/api/feeds', { name: 'Mine', query: { assignee: 'me' } });
    const lines = parseCsv((await anon.get(pathOf(r.body.url))).body);
    expect(lines[0]).toBe('Key,Type,Title,Status,Assignee,Epic key,Epic title,Sprint,Story points,Due date');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('WEB-2,story,');
    expect((await carol.client.post('/api/feeds', { name: 'x', columns: ['nope'] })).status).toBe(400);
    expect((await carol.client.post('/api/feeds', { name: 'x', columns: [] })).status).toBe(400);
    expect((await carol.client.post('/api/feeds', { columns: ['key'] })).status).toBe(400);
  });

  it('follows the owner: private project, deactivation and revoking give 404 or fewer rows', async () => {
    const r = await carol.client.post('/api/feeds', { name: 'All', query: {}, columns: ['key'] });
    const path = pathOf(r.body.url);
    expect(parseCsv((await anon.get(path)).body)).toHaveLength(4);

    await bob.client.patch('/api/projects/WEB', { visibility: 'private' });
    expect(parseCsv((await anon.get(path)).body)).toEqual(['Key']);
    await bob.client.put(`/api/projects/WEB/members/${carol.id}`, { role: 'viewer' });
    expect(parseCsv((await anon.get(path)).body)).toHaveLength(4);

    await ctx.admin.patch(`/api/admin/users/${carol.id}`, { status: 'deactivated' });
    expect((await anon.get(path)).status).toBe(404);
    await ctx.admin.patch(`/api/admin/users/${carol.id}`, { status: 'active' });
    expect((await anon.get(path)).status).toBe(200);
    await carol.client.post('/api/auth/login', { email: 'carol@example.com', password: PASSWORD }); // deactivation signed her out

    expect((await bob.client.del(`/api/feeds/${r.body.feed.id}`)).status).toBe(404); // not bob's
    expect((await carol.client.del(`/api/feeds/${r.body.feed.id}`)).status).toBe(200);
    expect((await anon.get(path)).status).toBe(404);
    expect((await carol.client.get('/api/feeds')).body.feeds).toHaveLength(0);
    const audit = await ctx.admin.get('/api/admin/audit');
    expect(audit.body.entries.some((e) => e.action === 'feed.revoked')).toBe(true);
  });

  it('turning the setting off stops every feed', async () => {
    const r = await carol.client.post('/api/feeds', { name: 'All', columns: ['key'] });
    const path = pathOf(r.body.url);
    await ctx.admin.patch('/api/admin/settings', { sheetFeeds: false });
    expect((await anon.get(path)).status).toBe(404);
    expect((await carol.client.post('/api/feeds', { name: 'x', columns: ['key'] })).status).toBe(403);
    await ctx.admin.patch('/api/admin/settings', { sheetFeeds: true });
    expect((await anon.get(path)).status).toBe(200);
  });

  it('unknown or malformed tokens give 404', async () => {
    expect((await anon.get('/feeds/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.csv')).status).toBe(404);
    expect((await anon.get('/feeds/short.csv')).status).toBe(404);
    expect((await anon.get('/feeds/x')).status).toBe(404);
  });
});
