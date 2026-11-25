import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser } from './helpers.js';

let ctx, bob, carol, statuses;
const create = (c, data, key = 'WEB') => c.post('/api/issues', { projectKey: key, ...data }).then((r) => r.body.issue);
const block = (c, from, to) => c.post(`/api/issues/${from}/links`, { type: 'blocks', targetKey: to });
const status = (name) => statuses.find((s) => s.name === name).id;
const listed = async (c, q = 'project=WEB') => Object.fromEntries((await c.get(`/api/issues?${q}`)).body.issues.map((i) => [i.key, i]));

beforeEach(async () => {
  ctx = await withAdmin();
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
  statuses = (await bob.client.post('/api/projects', { key: 'web', name: 'Website' })).body.project.statuses;
});

describe('blocked issues', () => {
  it('computes blocked and blockedBy in lists and the detail; done and trashed blockers do not count', async () => {
    const a = await create(bob.client, { title: 'A' });
    const b = await create(bob.client, { title: 'B' });
    const c = await create(bob.client, { title: 'C' });
    expect((await block(bob.client, a.key, c.key)).status).toBe(201);
    await block(bob.client, b.key, c.key);
    await bob.client.post(`/api/issues/${a.key}/links`, { type: 'relates', targetKey: b.key }); // not a block

    let l = await listed(bob.client);
    expect(l[c.key]).toMatchObject({ blocked: true, blockedBy: [a.key, b.key], blockedHidden: 0 });
    expect(l[a.key]).toMatchObject({ blocked: false, blockedBy: [] });
    expect(l[b.key].blocked).toBe(false);
    expect((await bob.client.get(`/api/issues/${c.key}`)).body.issue).toMatchObject({ blocked: true, blockedBy: [a.key, b.key] });

    // blocked filter
    expect(Object.keys(await listed(bob.client, 'project=WEB&blocked=1'))).toEqual([c.key]);

    // A done: only B left
    await bob.client.patch(`/api/issues/${a.key}`, { statusId: status('Done') });
    l = await listed(bob.client);
    expect(l[c.key].blockedBy).toEqual([b.key]);
    // B in the Trash: no longer blocked
    await bob.client.del(`/api/issues/${b.key}`);
    l = await listed(bob.client);
    expect(l[c.key]).toMatchObject({ blocked: false, blockedBy: [] });
    expect(Object.keys(await listed(bob.client, 'project=WEB&blocked=1'))).toEqual([]);
    // restored from the Trash: blocked again
    await bob.client.post(`/api/trash/${b.key}/restore`);
    expect((await listed(bob.client))[c.key].blocked).toBe(true);
    // the PATCH answer carries it too (the Issues page swaps the row)
    expect((await bob.client.patch(`/api/issues/${c.key}`, { priority: 'high' })).body.issue).toMatchObject({
      blocked: true,
      blockedBy: [b.key],
    });
  });

  it('works out large lists in chunks', async () => {
    const blocker = await create(bob.client, { title: 'Blocker' });
    const keys = [];
    for (let i = 0; i < 90; i++) keys.push((await create(bob.client, { title: `I${i}` })).key);
    await ctx.db.batch(
      keys.map((k) => ({
        sql: `INSERT INTO issue_links (id, source_id, target_id, type, created_at) SELECT ?, b.id, t.id, 'blocks', ? FROM issues b, issues t WHERE b.key = ? AND t.key = ?`,
        params: [`link-${k}`, new Date().toISOString(), blocker.key, k],
      })),
    );
    const r = await bob.client.get('/api/issues?project=WEB&limit=200');
    expect(r.body.issues.filter((i) => i.blocked)).toHaveLength(90);
  });

  it('tells the assignees of issues that are no longer blocked', async () => {
    const a = await create(bob.client, { title: 'A' });
    const b = await create(bob.client, { title: 'B' });
    const c = await create(bob.client, { title: 'C', assigneeId: carol.id });
    const d = await create(bob.client, { title: 'D', assigneeId: carol.id });
    await block(bob.client, a.key, c.key);
    await block(bob.client, b.key, c.key);
    await block(bob.client, a.key, d.key);
    const notes = () =>
      ctx.db.all(`SELECT message FROM notifications WHERE user_id = ? AND type = 'unblocked' ORDER BY message`, [carol.id]);
    await bob.client.patch(`/api/issues/${a.key}`, { statusId: status('Done') });
    expect((await notes()).map((n) => n.message)).toEqual([`${a.key} is done; ${d.key} is no longer blocked`]); // C still waits for B
    await bob.client.patch(`/api/issues/${b.key}`, { statusId: status('In Progress') });
    expect(await notes()).toHaveLength(1);
    await bob.client.post(`/api/issues/${b.key}/move`, { statusId: status('Done') }); // the board's move
    expect((await notes()).map((n) => n.message)).toContain(`${b.key} is done; ${c.key} is no longer blocked`);
    // reopening A blocks C and D again (no note); done again: both are told again
    await bob.client.patch(`/api/issues/${a.key}`, { statusId: status('To Do') });
    expect(await notes()).toHaveLength(2);
    await bob.client.patch(`/api/issues/${a.key}`, { statusId: status('Done') });
    expect(await notes()).toHaveLength(4);
    // a done issue that is changed in other ways sends nothing
    await bob.client.patch(`/api/issues/${a.key}`, { priority: 'low' });
    expect(await notes()).toHaveLength(4);
  });

  it('never names a blocker in a project the viewer cannot see', async () => {
    const c = await create(bob.client, { title: 'C', assigneeId: carol.id });
    await bob.client.post('/api/projects', { key: 'sec', name: 'Secret' });
    await bob.client.patch('/api/projects/SEC', { visibility: 'private' });
    const s = await create(bob.client, { title: 'Secret blocker' }, 'SEC');
    const w = await create(bob.client, { title: 'Open blocker' });
    await block(bob.client, s.key, c.key);
    await block(bob.client, w.key, c.key);

    const mine = (await listed(bob.client))[c.key];
    expect(mine.blockedBy.sort()).toEqual([s.key, w.key].sort());
    const list = await carol.client.get('/api/issues?project=WEB');
    const theirs = list.body.issues.find((i) => i.key === c.key);
    expect(theirs).toMatchObject({ blocked: true, blockedBy: [w.key], blockedHidden: 1 });
    expect(JSON.stringify(list.body)).not.toContain(s.key);
    const detail = await carol.client.get(`/api/issues/${c.key}`);
    expect(detail.body.issue).toMatchObject({ blocked: true, blockedBy: [w.key], blockedHidden: 1 });
    expect(JSON.stringify(detail.body)).not.toContain(s.key);
    expect(JSON.stringify(detail.body)).not.toContain('Secret blocker');

    // only the hidden blocker left: still blocked, nothing named
    await bob.client.patch(`/api/issues/${w.key}`, { statusId: status('Done') });
    const only = (await carol.client.get(`/api/issues/${c.key}`)).body.issue;
    expect(only).toMatchObject({ blocked: true, blockedBy: [], blockedHidden: 1 });
    expect(Object.keys(await listed(carol.client, 'project=WEB&blocked=1'))).toEqual([c.key]);

    // the unblock note leaves out the members-only key
    const secDone = (await bob.client.get('/api/projects/SEC')).body.project.statuses.find((x) => x.category === 'done').id;
    await bob.client.patch(`/api/issues/${s.key}`, { statusId: secDone });
    const note = await ctx.db.get(`SELECT message FROM notifications WHERE user_id = ? AND type = 'unblocked'`, [carol.id]);
    expect(note.message).toBe(`A blocking issue is done; ${c.key} is no longer blocked`);
  });

  it("shows an epic's dependencies", async () => {
    const epic = await create(bob.client, { type: 'epic', title: 'Epic' });
    const x = await create(bob.client, { title: 'X', parentKey: epic.key });
    const y = await create(bob.client, { title: 'Y', parentKey: epic.key });
    const z = await create(bob.client, { title: 'Z outside' });
    await block(bob.client, x.key, y.key);
    await block(bob.client, y.key, z.key);
    const d = (await bob.client.get(`/api/issues/${epic.key}`)).body.issue;
    expect(d.dependencies.map((e) => [e.from.key, e.to.key, e.from.child, e.to.child])).toEqual([
      [x.key, y.key, true, true],
      [y.key, z.key, true, false],
    ]);
    expect(d.children.find((i) => i.key === y.key)).toMatchObject({ blocked: true, blockedBy: [x.key] });
    // a task has no dependencies panel
    expect((await bob.client.get(`/api/issues/${x.key}`)).body.issue.dependencies).toBeUndefined();
  });
});
