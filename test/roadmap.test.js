import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser } from './helpers.js';

let ctx, bob, carol, statuses, token;
const create = (c, data, key = 'WEB') => c.post('/api/issues', { projectKey: key, ...data }).then((r) => r.body.issue);
const status = (name) => statuses.find((s) => s.name === name).id;
const roadmap = async (c, q = 'project=WEB') => (await c.get(`/api/roadmap?${q}`)).body;

beforeEach(async () => {
  ctx = await withAdmin();
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
  statuses = (await bob.client.post('/api/projects', { key: 'web', name: 'Website' })).body.project.statuses;
});

describe('start date', () => {
  it('is set on create, checked against the due date and kept in history', async () => {
    const a = await create(bob.client, { title: 'A', startDate: '2026-03-01', dueDate: '2026-03-10' });
    expect(a).toMatchObject({ startDate: '2026-03-01', dueDate: '2026-03-10' });
    const bad = await bob.client.post('/api/issues', { projectKey: 'WEB', title: 'B', startDate: '2026-04-02', dueDate: '2026-04-01' });
    expect(bad.status).toBe(400);
    expect(bad.body.error || bad.body.message || JSON.stringify(bad.body)).toMatch(/Start date must be on or before the due date/);
    expect((await bob.client.post('/api/issues', { projectKey: 'WEB', title: 'C', startDate: '1 March' })).status).toBe(400);

    let r = await bob.client.patch(`/api/issues/${a.key}`, { startDate: '2026-03-05' });
    expect(r.status).toBe(200);
    expect(r.body.changed).toEqual(['start_date']);
    expect(r.body.issue.startDate).toBe('2026-03-05');
    // start after the stored due date
    expect((await bob.client.patch(`/api/issues/${a.key}`, { startDate: '2026-03-11' })).status).toBe(400);
    // due before the stored start date
    expect((await bob.client.patch(`/api/issues/${a.key}`, { dueDate: '2026-03-04' })).status).toBe(400);
    // both moved together (a roadmap drag) is fine
    r = await bob.client.patch(`/api/issues/${a.key}`, { startDate: '2026-05-01', dueDate: '2026-05-09' });
    expect(r.status).toBe(200);
    expect(r.body.changed.sort()).toEqual(['due_date', 'start_date']);
    // clearing
    r = await bob.client.patch(`/api/issues/${a.key}`, { startDate: null });
    expect(r.body.issue.startDate).toBe(null);

    const hist = (await bob.client.get(`/api/issues/${a.key}`)).body.issue.history.filter((h) => h.field === 'start_date');
    expect(hist.map((h) => [h.from, h.to])).toEqual([
      ['2026-03-01', '2026-03-05'],
      ['2026-03-05', '2026-05-01'],
      ['2026-05-01', null],
    ]);
    // without a due date any start works
    const d = await create(bob.client, { title: 'D', startDate: '2030-01-01' });
    expect(d.startDate).toBe('2030-01-01');
  });

  it('is changed in bulk', async () => {
    const a = await create(bob.client, { title: 'A' });
    const b = await create(bob.client, { title: 'B', dueDate: '2026-01-05' });
    const r = await bob.client.post('/api/issues/bulk', { keys: [a.key, b.key], changes: { startDate: '2026-01-10' } });
    expect(r.status).toBe(200);
    expect(r.body.results.find((x) => x.key === a.key)).toMatchObject({ ok: true, changed: ['start_date'] });
    expect(r.body.results.find((x) => x.key === b.key)).toMatchObject({ ok: false, error: 'Start date must be on or before the due date' });
    expect((await bob.client.get(`/api/issues/${a.key}`)).body.issue.startDate).toBe('2026-01-10');
    const clear = await bob.client.post('/api/issues/bulk', { keys: [a.key], changes: { startDate: null } });
    expect(clear.body.updated).toBe(1);
    expect((await bob.client.get(`/api/issues/${a.key}`)).body.issue.startDate).toBe(null);
  });
});

describe('GET /api/roadmap', () => {
  it('returns epics with children, progress by count and by points, suggested dates and links', async () => {
    const e1 = await create(bob.client, { title: 'Epic one', type: 'epic', startDate: '2026-02-01', dueDate: '2026-03-31' });
    const e2 = await create(bob.client, { title: 'Epic two', type: 'epic' });
    const s1 = await create(bob.client, { title: 'S1', type: 'story', parentKey: e1.key, startDate: '2026-02-03', dueDate: '2026-02-10' });
    const s2 = await create(bob.client, { title: 'S2', type: 'task', parentKey: e1.key, dueDate: '2026-03-20', statusId: status('Done') });
    await create(bob.client, { title: 'S3', type: 'bug', parentKey: e1.key });
    await create(bob.client, { title: 'sub', type: 'subtask', parentKey: s1.key }); // never on the roadmap
    const p1 = await create(bob.client, { title: 'P1', type: 'story', parentKey: e2.key, storyPoints: 5, statusId: status('Done') });
    await create(bob.client, { title: 'P2', type: 'story', parentKey: e2.key, storyPoints: 3 });
    await create(bob.client, { title: 'P3', type: 'story', parentKey: e2.key }); // no points
    const orphan = await create(bob.client, { title: 'Loose task', type: 'task', dueDate: '2026-02-20' });
    await bob.client.post(`/api/issues/${s1.key}/links`, { type: 'blocks', targetKey: p1.key });
    await bob.client.post(`/api/issues/${s1.key}/links`, { type: 'relates', targetKey: s2.key }); // not a block
    await bob.client.post(`/api/issues/${s1.key}/links`, { type: 'blocks', targetKey: orphan.key }); // orphan not listed

    let r = await roadmap(bob.client);
    expect(r.epics.map((e) => e.key)).toEqual([e1.key, e2.key]);
    expect(r.orphans).toEqual([]);
    expect(r.truncated).toBe(false);
    const one = r.epics[0];
    expect(one).toMatchObject({ startDate: '2026-02-01', dueDate: '2026-03-31' });
    expect(one.children.map((c) => c.title)).toEqual(['S1', 'S2', 'S3']);
    expect(one.summary).toMatchObject({ total: 3, done: 1, byPoints: false, suggestedStart: '2026-02-03', suggestedDue: '2026-03-20' });
    expect(one.summary.progress).toBeCloseTo(1 / 3);
    const two = r.epics[1];
    expect(two.summary).toMatchObject({
      total: 3,
      done: 1,
      points: 8,
      pointsDone: 5,
      byPoints: true,
      suggestedStart: null,
      suggestedDue: null,
    });
    expect(two.summary.progress).toBeCloseTo(5 / 8);
    expect(r.links).toEqual([{ from: s1.key, to: p1.key }]);
    expect(r.projects).toEqual([{ key: 'WEB', name: 'Website', canEdit: true }]);
    expect((await roadmap(ctx.admin)).projects[0].canEdit).toBe(true);

    r = await roadmap(bob.client, 'project=WEB&includeOrphans=1');
    expect(r.orphans.map((o) => o.key)).toEqual([orphan.key]);
    expect(r.links).toHaveLength(2);
    expect(r.links).toEqual(
      expect.arrayContaining([
        { from: s1.key, to: p1.key },
        { from: s1.key, to: orphan.key },
      ]),
    );

    // all projects
    await bob.client.post('/api/projects', { key: 'ops', name: 'Ops' });
    await create(bob.client, { title: 'Ops epic', type: 'epic' }, 'OPS');
    r = await roadmap(bob.client, '');
    expect(r.epics.map((e) => e.projectKey)).toEqual(['OPS', 'WEB', 'WEB']);
  });

  it('hides private projects and trashed epics', async () => {
    const e = await create(bob.client, { title: 'Secret epic', type: 'epic' });
    await create(bob.client, { title: 'Child', type: 'story', parentKey: e.key });
    await bob.client.patch('/api/projects/WEB', { visibility: 'private' });
    expect((await carol.client.get('/api/roadmap?project=WEB')).status).toBe(404);
    expect((await roadmap(carol.client, '')).epics).toEqual([]);
    expect((await roadmap(ctx.admin)).epics).toHaveLength(1);

    const gone = await create(bob.client, { title: 'Gone epic', type: 'epic' });
    const child = await create(bob.client, { title: 'Child of gone', type: 'task', parentKey: gone.key });
    expect((await bob.client.del(`/api/issues/${gone.key}`)).status).toBe(200);
    const r = await roadmap(bob.client, 'project=WEB&includeOrphans=1');
    expect(r.epics.map((x) => x.key)).toEqual([e.key]);
    // its child is not in the Trash, so it now shows as an issue without an epic
    expect(r.orphans.map((x) => x.key)).toEqual([child.key]);
  });
});

describe('MCP start_date', () => {
  beforeEach(async () => {
    token = (await bob.client.post('/api/me/tokens', { name: 'Claude Code' })).body.token;
  });
  let id = 0;
  const tool = async (name, args = {}) => {
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
    return { error: r.isError ? r.content[0].text : null, data: r.isError ? null : JSON.parse(r.content[0].text) };
  };

  it('create_issue and update_issue take start_date', async () => {
    const c = await tool('create_issue', { project: 'WEB', title: 'Planned', start_date: '2026-06-01', due_date: '2026-06-30' });
    expect(c.error).toBe(null);
    expect(c.data).toMatchObject({ start: '2026-06-01', due: '2026-06-30' });
    const u = await tool('update_issue', { key: c.data.created, start_date: '2026-06-10' });
    expect(u.data.changed).toEqual(['start_date']);
    expect(u.data.now.start).toBe('2026-06-10');
    const bad = await tool('update_issue', { key: c.data.created, start_date: '2026-07-10' });
    expect(bad.error).toMatch(/Start date must be on or before the due date/);
    const clear = await tool('update_issue', { key: c.data.created, start_date: '' });
    expect(clear.data.now.start).toBeUndefined();
  });
});
