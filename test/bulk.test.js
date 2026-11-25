import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser } from './helpers.js';

let ctx, bob, carol, proj;
beforeEach(async () => {
  ctx = await withAdmin();
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
  proj = (await bob.client.post('/api/projects', { key: 'web', name: 'Website' })).body.project;
});

const create = (c, data, key = 'WEB') => c.post('/api/issues', { projectKey: key, ...data }).then((r) => r.body.issue);
const bulk = (c, data) => c.post('/api/issues/bulk', data);
const issue = async (key) => (await bob.client.get(`/api/issues/${key}`)).body.issue;

describe('bulk edit', () => {
  it('changes status, assignee and priority with history and notifications', async () => {
    const a = await create(bob.client, { title: 'A' });
    const b = await create(bob.client, { title: 'B' });
    const done = proj.statuses.find((s) => s.name === 'Done');
    const r = await bulk(bob.client, {
      keys: [a.key, b.key.toLowerCase()],
      changes: { statusId: done.id, assigneeId: carol.id, priority: 'high' },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ updated: 2, skipped: 0, quiet: false });
    expect(r.body.results.map((x) => x.key)).toEqual(['WEB-1', 'WEB-2']);
    expect(r.body.results[0].changed.sort()).toEqual(['assignee', 'priority', 'status']);
    const d = await issue(a.key);
    expect(d).toMatchObject({ status: { name: 'Done' }, assignee: { name: 'Carol' }, priority: 'high' });
    expect(d.resolvedAt).toBeTruthy();
    expect(d.history.find((h) => h.field === 'status')).toMatchObject({ from: 'To Do', to: 'Done' });
    expect(d.history.find((h) => h.field === 'assignee')).toMatchObject({ to: 'Carol' });
    const n = await carol.client.get('/api/notifications');
    expect(n.body.notifications.filter((x) => x.type === 'assigned')).toHaveLength(2);
  });

  it('adds and removes labels, sets sprint and due date', async () => {
    const a = await create(bob.client, { title: 'A', labels: ['ui', 'old'] });
    const b = await create(bob.client, { title: 'B' });
    const sprint = (await bob.client.post('/api/projects/WEB/sprints', {})).body.sprint;
    let r = await bulk(bob.client, { keys: [a.key, b.key], changes: { addLabels: ['new', 'ui'], removeLabels: ['old'] } });
    expect(r.body.updated).toBe(2);
    expect((await issue(a.key)).labels).toEqual(['new', 'ui']);
    expect((await issue(b.key)).labels).toEqual(['new', 'ui']);
    expect((await issue(a.key)).history.find((h) => h.field === 'labels')).toMatchObject({ from: 'old, ui', to: 'new, ui' });
    r = await bulk(bob.client, { keys: [a.key, b.key], changes: { sprintId: sprint.id, dueDate: '2026-12-24' } });
    expect(r.body.updated).toBe(2);
    expect(await issue(b.key)).toMatchObject({ sprint: { name: sprint.name }, dueDate: '2026-12-24' });
    await bulk(bob.client, { keys: [a.key, b.key], changes: { sprintId: null, dueDate: null } });
    expect(await issue(a.key)).toMatchObject({ sprint: null, dueDate: null });
    // labels and addLabels together are refused
    expect((await bulk(bob.client, { keys: [a.key], changes: { labels: ['x'], addLabels: ['y'] } })).status).toBe(400);
    // fields that make no sense in bulk
    expect((await bulk(bob.client, { keys: [a.key], changes: { title: 'Same title' } })).status).toBe(400);
  });

  it('refuses status and sprint changes across projects', async () => {
    await bob.client.post('/api/projects', { key: 'APP', name: 'App' });
    const a = await create(bob.client, { title: 'A' });
    const b = await create(bob.client, { title: 'B' }, 'APP');
    const done = proj.statuses.find((s) => s.name === 'Done');
    const r = await bulk(bob.client, { keys: [a.key, b.key], changes: { statusId: done.id } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/one project/);
    const sprint = (await bob.client.post('/api/projects/WEB/sprints', {})).body.sprint;
    expect((await bulk(bob.client, { keys: [a.key, b.key], changes: { sprintId: sprint.id } })).status).toBe(400);
    // fields shared by all projects work across projects
    const ok = await bulk(bob.client, { keys: [a.key, b.key], changes: { priority: 'low', sprintId: null } });
    expect(ok.body).toMatchObject({ updated: 2, skipped: 0 });
    expect((await issue(b.key)).priority).toBe('low');
  });

  it('collects per-issue errors and keeps going', async () => {
    const a = await create(bob.client, { title: 'A' });
    const sub = await create(bob.client, { title: 'S', type: 'subtask', parentKey: a.key });
    const r = await bulk(bob.client, { keys: [a.key, 'WEB-99', sub.key], changes: { priority: 'urgent' } });
    expect(r.status).toBe(200);
    expect(r.body.updated).toBe(0);
    expect(r.body.results.every((x) => !x.ok && x.error)).toBe(true);
    const r2 = await bulk(bob.client, { keys: [a.key, 'WEB-99', sub.key], changes: { priority: 'high' } });
    expect(r2.body).toMatchObject({ updated: 2, skipped: 1 });
    expect(r2.body.results[1]).toEqual({ key: 'WEB-99', ok: false, error: 'Issue not found' });
  });

  it('refuses workspace viewers and hides private projects', async () => {
    const vic = await addUser(ctx, { email: 'vic@example.com', name: 'Vic', role: 'viewer' });
    const a = await create(bob.client, { title: 'A' });
    expect((await bulk(vic.client, { keys: [a.key], changes: { priority: 'low' } })).status).toBe(403);
    expect((await bulk(vic.client, { keys: [a.key], action: 'delete' })).status).toBe(403);
    // a project viewer gets a per-issue refusal
    await bob.client.put(`/api/projects/WEB/members/${carol.id}`, { role: 'viewer' });
    await bob.client.patch('/api/projects/WEB', { visibility: 'private' });
    const r = await bulk(carol.client, { keys: [a.key], changes: { priority: 'low' } });
    expect(r.body.results[0]).toMatchObject({ ok: false, error: 'You cannot change issues in this project' });
    // not a member at all: the private project's issues are "not found" and do not count for the one-project check
    await bob.client.del(`/api/projects/WEB/members/${carol.id}`);
    const mine = (await carol.client.post('/api/projects', { key: 'CAR', name: 'Carol' })).body.project;
    const c1 = await create(carol.client, { title: 'C' }, 'CAR');
    const r2 = await bulk(carol.client, { keys: [a.key, c1.key], changes: { statusId: mine.statuses[1].id } });
    expect(r2.status).toBe(200);
    expect(r2.body.results).toEqual([
      { key: a.key, ok: false, error: 'Issue not found' },
      { key: c1.key, ok: true, changed: ['status'] },
    ]);
    expect((await issue(a.key)).status.name).toBe('To Do');
  });

  it('watches and unwatches', async () => {
    const a = await create(bob.client, { title: 'A' });
    const b = await create(bob.client, { title: 'B' });
    const r = await bulk(carol.client, { keys: [a.key, b.key], action: 'watch' });
    expect(r.body.updated).toBe(2);
    expect((await carol.client.get(`/api/issues/${a.key}`)).body.issue.watching).toBe(true);
    await bulk(carol.client, { keys: [a.key, b.key], action: 'unwatch' });
    expect((await carol.client.get(`/api/issues/${b.key}`)).body.issue.watching).toBe(false);
    expect((await bulk(carol.client, { keys: [a.key], action: 'archive' })).status).toBe(400);
  });

  it('deletes with the same rules as DELETE and one audit row', async () => {
    const a = await create(bob.client, { title: 'A' });
    const sub = await create(bob.client, { title: 'S', type: 'subtask', parentKey: a.key });
    const c1 = await create(carol.client, { title: 'Carol made this' });
    const b = await create(bob.client, { title: 'B' });
    // carol (not a project admin) may delete only what she reported
    const r = await bulk(carol.client, { keys: [a.key, c1.key, b.key], action: 'delete' });
    expect(r.body.results).toEqual([
      { key: a.key, ok: false, error: 'Only the reporter or a project admin can delete an issue' },
      { key: c1.key, ok: true },
      { key: b.key, ok: false, error: 'Only the reporter or a project admin can delete an issue' },
    ]);
    // parent and its sub-task both selected: both succeed
    const r2 = await bulk(bob.client, { keys: [a.key, sub.key], action: 'delete' });
    expect(r2.body).toMatchObject({ updated: 2, skipped: 0 });
    expect((await bob.client.get(`/api/issues/${sub.key}`)).status).toBe(404);
    const rows = await ctx.db.all(`SELECT action, details FROM audit_log WHERE action LIKE 'issue.%' ORDER BY created_at`);
    expect(rows.map((x) => x.action)).toEqual(['issue.bulk_delete', 'issue.bulk_delete']);
    expect(JSON.parse(rows[1].details)).toMatchObject({ count: 2, ok: 2, failed: 0 });
  });

  it('writes one audit row per call and caps at 500', async () => {
    const a = await create(bob.client, { title: 'A' });
    const b = await create(bob.client, { title: 'B' });
    await bulk(bob.client, { keys: [a.key, b.key], changes: { priority: 'low' } });
    const rows = await ctx.db.all(`SELECT details FROM audit_log WHERE action = 'issue.bulk_updated'`);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].details)).toMatchObject({ count: 2, ok: 2, fields: ['priority'], keys: [a.key, b.key] });
    const many = Array.from({ length: 501 }, (_, i) => `WEB-${i + 1}`);
    expect((await bulk(bob.client, { keys: many, changes: { priority: 'low' } })).status).toBe(400);
    const max = await bulk(bob.client, { keys: many.slice(0, 500), changes: { priority: 'high' } });
    expect(max.status).toBe(200);
    expect(max.body).toMatchObject({ updated: 2, skipped: 498, quiet: true });
    expect((await bulk(bob.client, { keys: [], changes: { priority: 'low' } })).status).toBe(400);
    expect((await bulk(bob.client, { keys: [a.key] })).status).toBe(400);
  });
});
