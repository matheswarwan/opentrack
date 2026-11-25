// Calendar (server/routes/calendar.js): issues by due date and start to due spans, sprints, .ics subscriptions.
import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser } from './helpers.js';

let ctx, bob, carol, gina, st;
// WEB: open, Bob's. OPS: members only, Bob's (Carol not in it). Gina: guest in WEB (read only).
beforeEach(async () => {
  ctx = await withAdmin({ PUBLIC_URL: 'https://tracker.example.com' });
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
  gina = await addUser(ctx, { email: 'gina@client.example', name: 'Gina', role: 'guest' });
  const p = (await bob.client.post('/api/projects', { key: 'WEB', name: 'Website' })).body.project;
  await bob.client.post('/api/projects', { key: 'OPS', name: 'Ops', visibility: 'private' });
  await bob.client.put(`/api/projects/WEB/members/${gina.id}`, { role: 'guest-view' });
  st = Object.fromEntries(p.statuses.map((s) => [s.name, s.id]));
});

const make = async (data, who = bob) => {
  const r = await who.client.post('/api/issues', { projectKey: 'WEB', title: 'Task', ...data });
  expect(r.status).toBe(201);
  return r.body.issue;
};
const cal = (who, q) => who.client.get(`/api/calendar?${new URLSearchParams(q)}`);
const keys = (r) => r.body.issues.map((i) => i.key);

describe('GET /api/calendar', () => {
  it('returns issues due in the range and spans that touch it', async () => {
    const a = await make({ title: 'Due in Nov', dueDate: '2026-11-10' });
    const b = await make({ title: 'Span over the start', startDate: '2026-10-25', dueDate: '2026-11-03' });
    await make({ title: 'Due in Dec', dueDate: '2026-12-05' });
    await make({ title: 'No date' });
    const c = await make({ title: 'Starts only', startDate: '2026-11-20' });
    const r = await cal(bob, { from: '2026-11-01', to: '2026-11-30' });
    expect(r.status).toBe(200);
    expect(keys(r)).toEqual([b.key, a.key, c.key]);
    expect(r.body.issues[0]).toMatchObject({ startDate: '2026-10-25', dueDate: '2026-11-03', canEdit: true, status: { category: 'todo' } });
    expect(r.body.truncated).toBe(false);
  });

  it('filters by project, assignee, type and done', async () => {
    const mine = await make({ dueDate: '2026-11-05', assigneeId: carol.id, type: 'bug' });
    const other = await make({ dueDate: '2026-11-06' });
    const done = await make({ dueDate: '2026-11-07' });
    await bob.client.patch(`/api/issues/${done.key}`, { statusId: st.Done });
    await bob.client.post('/api/issues', { projectKey: 'OPS', title: 'Ops', dueDate: '2026-11-08' });
    const range = { from: '2026-11-01', to: '2026-11-30' };
    expect(keys(await cal(bob, range))).toEqual([mine.key, other.key, 'OPS-1']);
    expect(keys(await cal(bob, { ...range, includeDone: '1', project: 'WEB' }))).toEqual([mine.key, other.key, done.key]);
    expect(keys(await cal(carol, { ...range, assignee: 'me' }))).toEqual([mine.key]);
    expect(keys(await cal(bob, { ...range, assignee: 'unassigned' }))).toEqual([other.key, 'OPS-1']);
    expect(keys(await cal(bob, { ...range, type: 'bug' }))).toEqual([mine.key]);
    expect((await cal(bob, { ...range, type: 'nope' })).status).toBe(400);
  });

  it('respects visibility: private projects, the Trash, guests', async () => {
    const web = await make({ dueDate: '2026-11-05' });
    const gone = await make({ dueDate: '2026-11-06' });
    await bob.client.post('/api/issues', { projectKey: 'OPS', title: 'Secret', dueDate: '2026-11-07' });
    await bob.client.del(`/api/issues/${gone.key}`);
    const range = { from: '2026-11-01', to: '2026-11-30' };
    expect(keys(await cal(bob, range))).toEqual([web.key, 'OPS-1']);
    expect(keys(await cal(carol, range))).toEqual([web.key]);
    expect(keys(await cal(carol, { ...range, project: 'OPS' }))).toEqual([]);
    const g = await cal(gina, range);
    expect(keys(g)).toEqual([web.key]);
    expect(g.body.issues[0].canEdit).toBe(false); // read only guest
  });

  it('a workspace viewer sees issues read only, also as a project member', async () => {
    const vic = await addUser(ctx, { email: 'vic@example.com', name: 'Vic', role: 'viewer' });
    const web = await make({ dueDate: '2026-11-05' });
    const range = { from: '2026-11-01', to: '2026-11-30' };
    let r = await cal(vic, range);
    expect(keys(r)).toEqual([web.key]);
    expect(r.body.issues[0].canEdit).toBe(false);
    await bob.client.put(`/api/projects/WEB/members/${vic.id}`, { role: 'member' });
    r = await cal(vic, range);
    expect(r.body.issues[0].canEdit).toBe(false);
    expect((await cal(carol, range)).body.issues[0].canEdit).toBe(true); // an open project: any member of the workspace edits
  });

  it('shows sprints in the range', async () => {
    const s = (await bob.client.post('/api/projects/WEB/sprints', { name: 'S1', startDate: '2026-11-02', endDate: '2026-11-13' })).body
      .sprint;
    await bob.client.post('/api/projects/OPS/sprints', { name: 'Hidden', startDate: '2026-11-02', endDate: '2026-11-13' });
    await bob.client.post('/api/projects/WEB/sprints', { name: 'Later', startDate: '2027-01-02', endDate: '2027-01-13' });
    const r = await cal(carol, { from: '2026-11-01', to: '2026-11-30', project: 'WEB' });
    expect(r.body.sprints).toEqual([
      expect.objectContaining({ id: s.id, name: 'S1', startDate: '2026-11-02', endDate: '2026-11-13', projectKey: 'WEB' }),
    ]);
    expect((await cal(carol, { from: '2026-11-01', to: '2026-11-30' })).body.sprints.map((x) => x.name)).toEqual(['S1']);
  });

  it('limits the range', async () => {
    expect((await cal(bob, { from: '2026-11-01' })).status).toBe(400);
    expect((await cal(bob, { from: '2026-11-30', to: '2026-11-01' })).status).toBe(400);
    expect((await cal(bob, { from: '2026-01-01', to: '2026-06-01' })).status).toBe(400);
    expect((await cal(bob, { from: '2026-11-01', to: '2027-02-01' })).status).toBe(200); // 92 days
    expect((await cal(bob, { from: 'soon', to: '2026-11-01' })).status).toBe(400);
  });

  it('moving an issue to another day is a normal PATCH with its permissions', async () => {
    const i = await make({ dueDate: '2026-11-05' });
    const r = await carol.client.patch(`/api/issues/${i.key}`, { dueDate: '2026-11-09' });
    expect(r.status).toBe(200);
    expect(keys(await cal(bob, { from: '2026-11-09', to: '2026-11-09' }))).toEqual([i.key]);
    expect((await gina.client.patch(`/api/issues/${i.key}`, { dueDate: '2026-11-10' })).status).toBe(403);
    // a start date after the new due date is refused
    await bob.client.patch(`/api/issues/${i.key}`, { startDate: '2026-11-08' });
    expect((await bob.client.patch(`/api/issues/${i.key}`, { dueDate: '2026-11-07' })).status).toBe(400);
  });
});

describe('calendar subscriptions (.ics)', () => {
  it("serves the owner's issues by secret URL and can be revoked", async () => {
    await make({ title: 'Launch, big; day', dueDate: new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10) });
    await bob.client.post('/api/issues', {
      projectKey: 'OPS',
      title: 'Secret ops',
      dueDate: new Date(Date.now() + 6 * 864e5).toISOString().slice(0, 10),
    });
    const r = await carol.client.post('/api/calendar/feeds', { name: 'My calendar', query: { project: 'WEB,OPS' } });
    expect(r.status).toBe(201);
    expect(r.body.url).toMatch(/^https:\/\/tracker\.example\.com\/feeds\/calendar\/[A-Za-z0-9_-]+\.ics$/);
    const path = new URL(r.body.url).pathname;
    const res = await ctx.app.request(path, {}, ctx.env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/calendar');
    const text = await res.text();
    expect(text).toContain('BEGIN:VCALENDAR');
    expect(text).toContain('SUMMARY:WEB-1 Launch\\, big\\; day');
    expect(text).not.toContain('Secret ops'); // Carol cannot see OPS
    // not listed among the Sheets feeds, and the CSV route does not serve it
    expect((await carol.client.get('/api/feeds')).body.feeds).toHaveLength(0);
    expect((await carol.client.get('/api/calendar/feeds')).body.feeds.map((f) => f.name)).toEqual(['My calendar']);
    expect((await ctx.app.request(path.replace('/calendar/', '/').replace('.ics', '.csv'), {}, ctx.env)).status).toBe(404);
    await carol.client.del(`/api/feeds/${r.body.feed.id}`);
    expect((await ctx.app.request(path, {}, ctx.env)).status).toBe(404);
  });
});
