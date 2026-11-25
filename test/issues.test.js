import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser } from './helpers.js';

let ctx, bob, carol, proj;
beforeEach(async () => {
  ctx = await withAdmin();
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
  proj = (await bob.client.post('/api/projects', { key: 'web', name: 'Website' })).body.project;
});

const create = (c, data) => c.post('/api/issues', { projectKey: 'WEB', ...data });

describe('projects', () => {
  it('creates with default workflow and unique key', async () => {
    expect(proj.key).toBe('WEB');
    expect(proj.statuses.map((s) => s.name)).toEqual(['To Do', 'In Progress', 'In Review', 'Done']);
    expect(proj.canAdmin).toBe(true);
    expect((await carol.client.post('/api/projects', { key: 'WEB', name: 'x' })).status).toBe(409);
    expect((await carol.client.post('/api/projects', { key: '1AB', name: 'x' })).status).toBe(400);
    expect((await carol.client.get('/api/projects')).body.projects).toHaveLength(1);
  });

  it('private projects are hidden from non-members', async () => {
    await bob.client.patch('/api/projects/WEB', { visibility: 'private' });
    expect((await carol.client.get('/api/projects')).body.projects).toHaveLength(0);
    expect((await carol.client.get('/api/projects/WEB')).status).toBe(404);
    expect((await ctx.admin.get('/api/projects/WEB')).status).toBe(200);
    await bob.client.put(`/api/projects/WEB/members/${carol.id}`, { role: 'viewer' });
    expect((await carol.client.get('/api/projects/WEB')).status).toBe(200);
    expect((await create(carol.client, { title: 'nope' })).status).toBe(403);
    await bob.client.put(`/api/projects/WEB/members/${carol.id}`, { role: 'member' });
    expect((await create(carol.client, { title: 'yes' })).status).toBe(201);
    expect((await carol.client.patch('/api/projects/WEB', { name: 'x' })).status).toBe(403);
  });

  it('manages statuses', async () => {
    const add = await bob.client.post('/api/projects/WEB/statuses', { name: 'QA', category: 'in_progress', wipLimit: 3 });
    expect(add.body.statuses.map((s) => s.name)).toContain('QA');
    const qa = add.body.statuses.find((s) => s.name === 'QA');
    const i = await create(bob.client, { title: 'x', statusId: qa.id });
    expect((await bob.client.del(`/api/projects/WEB/statuses/${qa.id}`)).status).toBe(400);
    const todo = add.body.statuses[0];
    expect((await bob.client.del(`/api/projects/WEB/statuses/${qa.id}?moveTo=${todo.id}`)).status).toBe(200);
    expect((await bob.client.get(`/api/issues/${i.body.issue.key}`)).body.issue.status.name).toBe('To Do');
  });
});

describe('issues', () => {
  it('creates sequential keys and full details', async () => {
    const a = await create(bob.client, {
      title: 'First',
      assigneeId: carol.id,
      labels: ['ui', 'ui', 'needs review'],
      priority: 'high',
      storyPoints: 3,
    });
    const b = await create(bob.client, { title: 'Second', type: 'bug' });
    expect(a.status).toBe(201);
    expect([a.body.issue.key, b.body.issue.key]).toEqual(['WEB-1', 'WEB-2']);
    expect(a.body.issue).toMatchObject({
      priority: 'high',
      storyPoints: 3,
      labels: ['needs-review', 'ui'],
      assignee: { name: 'Carol' },
      reporter: { name: 'Bob' },
    });
    const d = await bob.client.get('/api/issues/web-1');
    expect(d.body.issue.watchers.map((w) => w.name).sort()).toEqual(['Bob', 'Carol']);
    expect(d.body.issue.history[0].field).toBe('created');
    // carol got a notification
    const n = await carol.client.get('/api/notifications');
    expect(n.body.notifications[0]).toMatchObject({ type: 'assigned', issueKey: 'WEB-1' });
    expect((await carol.client.get('/api/me')).body.unreadNotifications).toBe(1);
  });

  it('updates fields, records history and notifies watchers', async () => {
    const { key } = (await create(bob.client, { title: 'Fix header' })).body.issue;
    const done = proj.statuses.find((s) => s.name === 'Done');
    const r = await carol.client.patch(`/api/issues/${key}`, {
      title: 'Fix the header',
      statusId: done.id,
      assigneeId: carol.id,
      dueDate: '2026-12-01',
      labels: ['x'],
    });
    expect(r.status).toBe(200);
    expect(r.body.changed.sort()).toEqual(['assignee', 'due_date', 'labels', 'status', 'title']);
    expect(r.body.issue.resolvedAt).toBeTruthy();
    const d = await bob.client.get(`/api/issues/${key}`);
    expect(d.body.issue.history.find((h) => h.field === 'status')).toMatchObject({ from: 'To Do', to: 'Done' });
    const n = await bob.client.get('/api/notifications');
    expect(n.body.notifications.map((x) => x.type)).toContain('status');
    // no-op patch records nothing
    const again = await carol.client.patch(`/api/issues/${key}`, { title: 'Fix the header' });
    expect(again.body.changed).toEqual([]);
    expect((await carol.client.patch(`/api/issues/${key}`, { title: '' })).status).toBe(400);
    expect((await carol.client.patch(`/api/issues/${key}`, { priority: 'urgent' })).status).toBe(400);
  });

  it('enforces epic / sub-task hierarchy', async () => {
    const epic = (await create(bob.client, { title: 'Epic', type: 'epic' })).body.issue;
    const story = (await create(bob.client, { title: 'Story', type: 'story', parentKey: epic.key })).body.issue;
    expect(story.parent.key).toBe(epic.key);
    expect((await create(bob.client, { title: 'Sub', type: 'subtask' })).status).toBe(400);
    expect((await create(bob.client, { title: 'Sub', type: 'subtask', parentKey: epic.key })).status).toBe(400);
    const sub = await create(bob.client, { title: 'Sub', type: 'subtask', parentKey: story.key });
    expect(sub.status).toBe(201);
    expect((await create(bob.client, { title: 'Bad', type: 'task', parentKey: story.key })).status).toBe(400);
    const d = await bob.client.get(`/api/issues/${story.key}`);
    expect(d.body.issue.children.map((c) => c.key)).toEqual([sub.body.issue.key]);
    // deleting the story removes its sub-tasks
    expect((await bob.client.del(`/api/issues/${story.key}`)).status).toBe(200);
    expect((await bob.client.get(`/api/issues/${sub.body.issue.key}`)).status).toBe(404);
  });

  it('searches with filters, text and CSV export', async () => {
    await create(bob.client, { title: 'Login page broken', type: 'bug', assigneeId: carol.id, labels: ['auth'] });
    await create(bob.client, { title: 'Add footer', description: 'with links to login' });
    await create(bob.client, { title: 'Unrelated' });
    const s = (q) => bob.client.get(`/api/issues?${new URLSearchParams(q)}`);
    expect((await s({ q: 'login' })).body.total).toBe(2);
    expect((await s({ q: 'web-3' })).body.issues[0].title).toBe('Unrelated');
    expect((await s({ type: 'bug' })).body.total).toBe(1);
    expect((await s({ assignee: 'unassigned' })).body.total).toBe(2);
    expect((await s({ assignee: carol.id, label: 'auth' })).body.total).toBe(1);
    expect((await s({ q: '100%' })).body.total).toBe(0);
    const csv = await bob.client.get('/api/issues.csv?project=WEB');
    expect(csv.body.split('\n')).toHaveLength(4);
    expect(csv.body).toContain('Login page broken');
  });

  it('moves on the board between neighbours and changes status', async () => {
    const keys = [];
    for (const t of ['a', 'b', 'c']) keys.push((await create(bob.client, { title: t })).body.issue.key);
    const inProgress = proj.statuses.find((s) => s.name === 'In Progress');
    // move c between a and b, same column
    await bob.client.post(`/api/issues/${keys[2]}/move`, { prevKey: keys[0], nextKey: keys[1] });
    let list = await bob.client.get('/api/issues?project=WEB&sort=rank');
    expect(list.body.issues.map((i) => i.title)).toEqual(['a', 'c', 'b']);
    // move a to In Progress
    const m = await bob.client.post(`/api/issues/${keys[0]}/move`, { statusId: inProgress.id });
    expect(m.body.issue.status.name).toBe('In Progress');
    // many moves into the same gap still keep order (renumbering)
    // halve the gap next to a until ranks collide and the project is renumbered
    for (let i = 0; i < 30; i++) {
      await bob.client.post(`/api/issues/${keys[1]}/move`, { prevKey: keys[0], nextKey: keys[2] });
      await bob.client.post(`/api/issues/${keys[2]}/move`, { prevKey: keys[0], nextKey: keys[1] });
    }
    list = await bob.client.get('/api/issues?project=WEB&sort=rank');
    expect(list.body.issues.map((i) => i.title)).toEqual(['a', 'c', 'b']);
    const ranks = list.body.issues.map((i) => i.rank);
    expect(ranks[1] - ranks[0]).toBeGreaterThan(1e-6);
  });

  it('comments with mentions, links, watch, work log', async () => {
    const { key } = (await create(bob.client, { title: 'Thing' })).body.issue;
    const other = (await create(bob.client, { title: 'Other' })).body.issue;
    const cm = await carol.client.post(`/api/issues/${key}/comments`, {
      body: `Status: done with part 1. cc @[Ada Admin](user:${(await ctx.admin.get('/api/me')).body.user.id})`,
    });
    expect(cm.status).toBe(201);
    const adminN = await ctx.admin.get('/api/notifications');
    expect(adminN.body.notifications[0].type).toBe('mentioned');
    const bobN = await bob.client.get('/api/notifications');
    expect(bobN.body.notifications[0].type).toBe('comment');
    expect((await bob.client.patch(`/api/comments/${cm.body.comment.id}`, { body: 'hack' })).status).toBe(403);
    expect((await carol.client.patch(`/api/comments/${cm.body.comment.id}`, { body: 'edited' })).status).toBe(200);
    expect((await bob.client.post(`/api/issues/${key}/links`, { type: 'blocks', targetKey: other.key })).status).toBe(201);
    expect((await bob.client.post(`/api/issues/${key}/links`, { type: 'blocks', targetKey: other.key })).status).toBe(409);
    const otherDetail = await bob.client.get(`/api/issues/${other.key}`);
    expect(otherDetail.body.issue.links[0]).toMatchObject({ type: 'blocks', direction: 'in', issue: { key } });
    expect((await carol.client.post(`/api/issues/${key}/worklogs`, { hours: 1.5, note: 'pairing' })).status).toBe(201);
    expect((await carol.client.post(`/api/issues/${key}/worklogs`, { hours: 30 })).status).toBe(400);
    await carol.client.del(`/api/issues/${key}/watch`);
    const d = await bob.client.get(`/api/issues/${key}`);
    expect(d.body.issue).toMatchObject({ loggedHours: 1.5 });
    expect(d.body.issue.watchers.map((w) => w.name)).toEqual(['Bob']);
    expect(d.body.issue.comments[0].body).toBe('edited');
    const act = await bob.client.get('/api/activity?project=WEB');
    expect(act.body.items.some((x) => x.kind === 'comment')).toBe(true);
  });

  it('only reporter or project admin can delete', async () => {
    const { key } = (await create(bob.client, { title: 'Mine' })).body.issue;
    expect((await carol.client.del(`/api/issues/${key}`)).status).toBe(403);
    expect((await bob.client.del(`/api/issues/${key}`)).status).toBe(200);
  });
});

describe('sprints', () => {
  it('plans, starts and completes a sprint', async () => {
    const s1 = (await bob.client.post('/api/projects/WEB/sprints', {})).body.sprint;
    const s2 = (await bob.client.post('/api/projects/WEB/sprints', { name: 'Next' })).body.sprint;
    expect(s1.name).toBe('WEB Sprint 1');
    const a = (await create(bob.client, { title: 'a', sprintId: s1.id })).body.issue;
    const b = (await create(bob.client, { title: 'b', sprintId: s1.id })).body.issue;
    await create(bob.client, { title: 'backlog item' });
    expect((await bob.client.get('/api/issues?project=WEB&sprint=backlog')).body.total).toBe(1);
    expect((await bob.client.post(`/api/sprints/${s1.id}/start`, {})).status).toBe(200);
    expect((await bob.client.post(`/api/sprints/${s2.id}/start`, {})).status).toBe(409);
    expect((await bob.client.get('/api/issues?project=WEB&sprint=active')).body.total).toBe(2);
    const done = proj.statuses.find((s) => s.category === 'done');
    await bob.client.patch(`/api/issues/${a.key}`, { statusId: done.id });
    const comp = await bob.client.post(`/api/sprints/${s1.id}/complete`, { moveTo: s2.id });
    expect(comp.body).toMatchObject({ movedIssues: 1, sprint: { state: 'closed' } });
    expect((await bob.client.get(`/api/issues/${b.key}`)).body.issue.sprint.id).toBe(s2.id);
    expect((await bob.client.patch(`/api/issues/${b.key}`, { sprintId: s1.id })).status).toBe(400);
    // backlog drag into a sprint via move
    const m = await bob.client.post(`/api/issues/${b.key}/move`, { sprintId: 'backlog' });
    expect(m.body.issue.sprint).toBeNull();
  });
});

describe('dashboard, filters, users', () => {
  it('returns my work and saved filters', async () => {
    await create(bob.client, { title: 'For carol', assigneeId: carol.id, dueDate: '2020-01-01' });
    const d = await carol.client.get('/api/dashboard');
    expect(d.body.assigned).toHaveLength(1);
    expect(d.body.dueSoon[0].overdue).toBe(true);
    expect(d.body.counts.todo).toBe(1);
    const f = await carol.client.post('/api/filters', { name: 'My bugs', query: { type: 'bug', assignee: 'me' }, shared: true });
    expect(f.status).toBe(201);
    expect((await bob.client.get('/api/filters')).body.filters[0]).toMatchObject({ name: 'My bugs', mine: false });
    expect((await bob.client.del(`/api/filters/${f.body.id}`)).status).toBe(404);
    const users = await bob.client.get('/api/users?q=car');
    expect(users.body.users.map((u) => u.name)).toEqual(['Carol']);
  });
});

describe('watchers', () => {
  it('lets an editor add and remove other watchers, with a notification', async () => {
    const { key } = (await create(bob.client, { title: 'Watch me' })).body.issue;
    expect((await bob.client.post(`/api/issues/${key}/watchers`, { userId: carol.id })).status).toBe(201);
    expect((await bob.client.post(`/api/issues/${key}/watchers`, { userId: carol.id })).body.added).toBe(false);
    const d = await bob.client.get(`/api/issues/${key}`);
    expect(d.body.issue.watchers.map((w) => w.name).sort()).toEqual(['Bob', 'Carol']);
    const n = await carol.client.get('/api/notifications');
    expect(n.body.notifications[0]).toMatchObject({ type: 'watching', issueKey: key });
    expect((await bob.client.del(`/api/issues/${key}/watchers/${carol.id}`)).status).toBe(200);
    expect((await bob.client.get(`/api/issues/${key}`)).body.issue.watchers.map((w) => w.name)).toEqual(['Bob']);
    expect((await bob.client.post(`/api/issues/${key}/watchers`, { userId: 'nope' })).status).toBe(400);
  });

  it('refuses people who cannot see a private project', async () => {
    await bob.client.patch('/api/projects/WEB', { visibility: 'private' });
    const { key } = (await create(bob.client, { title: 'Secret' })).body.issue;
    const r = await bob.client.post(`/api/issues/${key}/watchers`, { userId: carol.id });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('cannot see this project');
  });
});

describe('activity filters', () => {
  it('filters by type, person and date, and pages with before', async () => {
    const a = (await create(bob.client, { title: 'A' })).body.issue.key;
    await create(carol.client, { title: 'B' });
    const p = (await bob.client.get('/api/projects/WEB')).body.project;
    await bob.client.patch(`/api/issues/${a}`, { statusId: p.statuses[1].id });
    await carol.client.post(`/api/issues/${a}/comments`, { body: 'hello' });
    const q = (s) => bob.client.get(`/api/activity?project=WEB&${s}`).then((r) => r.body);
    expect((await q('type=comment')).items.map((i) => i.kind)).toEqual(['comment']);
    expect((await q('type=status')).items.map((i) => i.field)).toEqual(['status']);
    expect((await q('type=created')).items).toHaveLength(2);
    expect((await q(`actor=${carol.id}`)).items.map((i) => i.actor.name)).toEqual(['Carol', 'Carol']);
    expect((await q('from=2000-01-01&to=2000-01-02')).items).toHaveLength(0);
    const page1 = await q('limit=2');
    expect(page1.items).toHaveLength(2);
    expect(page1.more).toBe(true);
    const page2 = await q(`limit=2&before=${encodeURIComponent(page1.nextBefore)}`);
    expect(page2.items.every((i) => i.createdAt < page1.nextBefore)).toBe(true);
  });
});

// tagging yourself is a reminder and notifies you.
describe('self-mentions', () => {
  it('notify the author in the description, in edits and in comments; other own actions still do not', async () => {
    const { withAdmin } = await import('./helpers.js');
    const ctx = await withAdmin();
    const me = (await ctx.admin.get('/api/me')).body.user;
    await ctx.admin.post('/api/projects', { key: 'SELF', name: 'Self' });
    const tag = `@[${me.name}](user:${me.id})`;
    const r = await ctx.admin.post('/api/issues', {
      projectKey: 'SELF',
      title: 'Remind me',
      assigneeId: me.id,
      description: `todo ${tag}`,
    });
    expect(r.status).toBe(201);
    await ctx.admin.post(`/api/issues/${r.body.issue.key}/comments`, { body: `later ${tag}` });
    const list = (await ctx.admin.get('/api/notifications')).body.notifications.map((n) => n.message);
    expect(list).toContain('You mentioned yourself in SELF-1');
    expect(list).toContain('You mentioned yourself on SELF-1');
    expect(list.some((m) => m.includes('assigned'))).toBe(false); // assigning yourself is not notified
  });
});
