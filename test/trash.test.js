import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser, client } from './helpers.js';
import { runDueJobs, resetJobThrottle } from '../server/lib/jobs.js';
import { dueIssues } from '../server/lib/jobs/reminders.js';

let ctx, bob, carol, dave, clockMs;
const today = new Date().toISOString().slice(0, 10);
const create = (who, data) =>
  who.client.post('/api/issues', { projectKey: 'WEB', ...data }).then((r) => {
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    return r.body.issue;
  });
const keys = (list) => list.map((i) => i.key);
const count = async (sql, params = []) => (await ctx.db.get(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM ${sql}`, params)).n;

beforeEach(async () => {
  clockMs = Date.now();
  resetJobThrottle();
  ctx = await withAdmin({ now: () => clockMs, PUBLIC_URL: 'https://tracker.example.com' });
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' }); // creates WEB: project lead (project admin)
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' }); // member of an open project
  dave = await addUser(ctx, { email: 'dave@example.com', name: 'Dave', role: 'viewer' });
  expect((await bob.client.post('/api/projects', { key: 'web', name: 'Website' })).status).toBe(201);
});

describe('deleting moves issues to the Trash', () => {
  let epic, story, sub, keep, sprint, token;
  beforeEach(async () => {
    sprint = (await bob.client.post('/api/projects/WEB/sprints', { name: 'S1' })).body.sprint;
    epic = await create(bob, { type: 'epic', title: 'Epic' }); // WEB-1
    story = await create(bob, {
      type: 'story',
      title: 'ZZGONE story',
      parentKey: epic.key,
      assigneeId: carol.id,
      dueDate: today,
      labels: ['gone-label'],
      sprintId: sprint.id,
      storyPoints: 5,
      description: `Hello @[Carol](user:${carol.id})`,
    }); // WEB-2
    sub = await create(bob, { type: 'subtask', title: 'ZZGONE sub', parentKey: story.key, assigneeId: carol.id }); // WEB-3
    keep = await create(bob, { type: 'story', title: 'Keep me', parentKey: epic.key, assigneeId: carol.id, sprintId: sprint.id }); // WEB-4
    expect((await bob.client.post(`/api/issues/${keep.key}/links`, { targetKey: story.key, type: 'relates' })).status).toBe(201);
    expect((await carol.client.post(`/api/issues/${story.key}/worklogs`, { hours: 2, workDate: today })).status).toBe(201);
    expect((await bob.client.post(`/api/issues/${story.key}/comments`, { body: 'ZZGONE comment' })).status).toBe(201);
    expect((await bob.client.post(`/api/sprints/${sprint.id}/start`, {})).status).toBe(200);
    token = (await carol.client.post('/api/me/tokens', { name: 'AI' })).body.token;
  });

  async function mcp(name, args = {}) {
    const res = await ctx.app.request(
      'http://t.example/mcp',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      },
      ctx.env,
    );
    const r = (await res.json()).result;
    return { error: r.isError ? r.content[0].text : null, data: r.isError ? null : JSON.parse(r.content[0].text) };
  }

  it('takes its sub-tasks along, writes issue.trashed and keeps every row', async () => {
    const r = await bob.client.del(`/api/issues/${story.key}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, trashed: true, subtasks: 1 });
    const rows = await ctx.db.all('SELECT key, deleted_at, deleted_by, deleted_with FROM issues WHERE key IN (?, ?) ORDER BY key', [
      story.key,
      sub.key,
    ]);
    expect(rows[0]).toMatchObject({ key: story.key, deleted_by: bob.id, deleted_with: null });
    expect(rows[1]).toMatchObject({ key: sub.key, deleted_by: bob.id });
    expect(rows[1].deleted_with).toBeTruthy();
    expect(rows.every((x) => x.deleted_at)).toBe(true);
    expect(await count('comments WHERE body = ?', ['ZZGONE comment'])).toBe(1);
    expect(await count('worklogs')).toBe(1);
    const audit = await ctx.db.all(`SELECT action, details FROM audit_log WHERE action LIKE 'issue.%'`);
    expect(audit.map((a) => a.action)).toEqual(['issue.trashed']);
    expect(JSON.parse(audit[0].details)).toMatchObject({ key: story.key, subtasks: 1 });
  });

  it('is invisible in every list and read', async () => {
    const gone = [story.key, sub.key];
    const noGone = (text) => {
      const s = typeof text === 'string' ? text : JSON.stringify(text);
      expect(s).not.toContain('ZZGONE');
    };
    expect((await bob.client.del(`/api/issues/${story.key}`)).status).toBe(200);

    // detail and anything under an issue key: 404
    for (const k of gone) expect((await bob.client.get(`/api/issues/${k}`)).status).toBe(404);
    expect((await bob.client.patch(`/api/issues/${story.key}`, { title: 'x' })).status).toBe(404);
    expect((await bob.client.post(`/api/issues/${story.key}/comments`, { body: 'x' })).status).toBe(404);
    expect((await bob.client.post(`/api/issues/${story.key}/worklogs`, { hours: 1 })).status).toBe(404);
    expect((await bob.client.post(`/api/issues/${story.key}/watch`)).status).toBe(404);

    // search (issueFilter), CSV, board and backlog queries, parent pickers
    const all = await bob.client.get('/api/issues?project=WEB&limit=100');
    expect(keys(all.body.issues).sort()).toEqual([epic.key, keep.key].sort());
    expect(all.body.total).toBe(2);
    expect((await bob.client.get('/api/issues?q=ZZGONE')).body.total).toBe(0);
    expect((await bob.client.get(`/api/issues?q=${story.key}`)).body.total).toBe(0);
    noGone((await bob.client.get('/api/issues.csv?project=WEB')).body);
    noGone((await bob.client.get(`/api/issues?project=WEB&sprint=open&sort=rank`)).body); // board
    noGone((await bob.client.get(`/api/issues?project=WEB&sprint=${sprint.id}`)).body); // sprint lists
    noGone((await bob.client.get(`/api/issues?project=WEB&category=todo,in_progress&type=story,task,bug&limit=200`)).body); // parent picker for sub-tasks
    expect((await create(bob, { type: 'story', title: 'x', parentKey: epic.key })).key).toBeTruthy();
    expect((await bob.client.post('/api/issues', { projectKey: 'WEB', type: 'subtask', title: 'x', parentKey: story.key })).status).toBe(
      400,
    );
    expect((await bob.client.post(`/api/issues/${keep.key}/links`, { targetKey: story.key, type: 'blocks' })).status).toBe(400);

    // children and links on the issues that are left
    const e = (await bob.client.get(`/api/issues/${epic.key}`)).body.issue;
    expect(keys(e.children)).not.toContain(story.key);
    const k = (await bob.client.get(`/api/issues/${keep.key}`)).body.issue;
    expect(k.links).toEqual([]);

    // my work (dashboard), activity, notifications, labels, project counts
    const dash = (await carol.client.get('/api/dashboard')).body;
    noGone(dash);
    expect(dash.counts).toMatchObject({ todo: 1 });
    noGone((await carol.client.get('/api/activity?project=WEB')).body);
    noGone((await carol.client.get('/api/activity')).body);
    const notes = (await carol.client.get('/api/notifications')).body.notifications;
    expect(notes.filter((n) => gone.includes(n.issueKey))).toEqual([]);
    expect((await carol.client.get('/api/me')).body.unreadNotifications).toBe(notes.filter((n) => !n.read).length);
    expect(await count('notifications WHERE user_id = ?', [carol.id])).toBeGreaterThan(notes.length); // kept for a restore
    expect((await bob.client.get('/api/labels?q=gone')).body.labels).toEqual([]);
    expect((await bob.client.get('/api/projects')).body.projects.find((p) => p.key === 'WEB').openIssues).toBe(3); // epic, keep, x

    // reports: project reports, custom reports, timesheet
    noGone((await bob.client.get('/api/projects/WEB/reports')).body);
    const rep = await bob.client.post('/api/report-data', {
      source: { query: { project: 'WEB' } },
      kind: 'breakdown',
      options: { groupBy: 'status' },
    });
    expect(rep.status).toBe(200);
    expect(rep.body.total).toBe(3);
    noGone((await bob.client.post('/api/report-data', { source: { query: {} }, kind: 'list', options: {} })).body);
    const ts = (await carol.client.get(`/api/timesheet?from=${today}&to=${today}`)).body;
    noGone(ts);

    // Google Sheets feed
    const feed = await carol.client.post('/api/feeds', { name: 'All', query: { project: 'WEB' } });
    expect(feed.status).toBe(201);
    const csv = await client(ctx).get(new URL(feed.body.url).pathname);
    expect(csv.status).toBe(200);
    noGone(csv.body);

    // MCP tools (they go through the API)
    const found = await mcp('search_issues', { project: 'WEB' });
    expect(found.error).toBe(null);
    noGone(found.data);
    expect((await mcp('get_issue', { key: story.key })).error).toBeTruthy();
    noGone((await mcp('my_work')).data);

    // jobs: due-date reminders and the digest
    expect(await dueIssues(ctx.db, { id: carol.id, role: 'member' }, today)).toEqual([]);
    noGone((await carol.client.get('/api/digest')).body);

    // completing the sprint moves only live issues
    const done = await bob.client.post(`/api/sprints/${sprint.id}/complete`, { moveTo: 'backlog' });
    expect(done.body.movedIssues).toBe(1);
    expect((await ctx.db.get('SELECT sprint_id FROM issues WHERE key = ?', [story.key])).sprint_id).toBe(sprint.id);
  });

  it('shows an issue whose epic is in the Trash without a parent', async () => {
    expect((await bob.client.del(`/api/issues/${epic.key}`)).status).toBe(200);
    const k = (await bob.client.get(`/api/issues/${keep.key}`)).body.issue;
    expect(k.parent).toBe(null);
    expect((await bob.client.get(`/api/issues?parent=${epic.key}`)).body.total).toBe(0);
    // restoring the epic links its children again (they kept parent_id)
    expect((await bob.client.post(`/api/trash/${epic.key}/restore`)).status).toBe(200);
    expect((await bob.client.get(`/api/issues/${keep.key}`)).body.issue.parent.key).toBe(epic.key);
  });

  it('lists, restores with sub-tasks, and deletes forever', async () => {
    expect((await bob.client.del(`/api/issues/${story.key}`)).status).toBe(200);
    const list = await bob.client.get('/api/trash');
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ trashDays: 30, total: 1 });
    expect(list.body.items[0]).toMatchObject({
      key: story.key,
      title: 'ZZGONE story',
      subtasks: 1,
      canPurge: true,
      deletedBy: { name: 'Bob' },
      project: { key: 'WEB' },
    });
    expect(Date.parse(list.body.items[0].purgeAfter) - Date.parse(list.body.items[0].deletedAt)).toBe(30 * 864e5);
    // the sub-task deleted with it is not its own item and cannot be restored alone
    expect((await bob.client.post(`/api/trash/${sub.key}/restore`)).status).toBe(400);

    const r = await bob.client.post(`/api/trash/${story.key}/restore`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ subtasks: 1, parentDropped: null });
    expect((await bob.client.get(`/api/issues/${sub.key}`)).status).toBe(200);
    const back = (await bob.client.get(`/api/issues/${story.key}`)).body.issue;
    expect(back.parent.key).toBe(epic.key);
    expect(back.children.map((c) => c.key)).toEqual([sub.key]);
    expect(back.history.at(-1)).toMatchObject({ field: 'restored' });
    expect((await bob.client.get('/api/trash')).body.total).toBe(0);
    expect((await bob.client.post(`/api/trash/${story.key}/restore`)).status).toBe(404);

    // a sub-task deleted on its own is its own item
    expect((await bob.client.del(`/api/issues/${sub.key}`)).status).toBe(200);
    expect(keys((await bob.client.get('/api/trash')).body.items)).toEqual([sub.key]);
    // its parent then deleted: the sub-task cannot come back before the parent
    expect((await bob.client.del(`/api/issues/${story.key}`)).status).toBe(200);
    expect((await bob.client.post(`/api/trash/${sub.key}/restore`)).status).toBe(400);

    // Delete forever: the story and its sub-tasks, rows cascade, the key stays reserved
    const d = await bob.client.del(`/api/trash/${story.key}`);
    expect(d.status).toBe(200);
    expect(await count('issues WHERE key IN (?, ?)', [story.key, sub.key])).toBe(0);
    expect(await count('comments WHERE body = ?', ['ZZGONE comment'])).toBe(0);
    expect(await count('worklogs')).toBe(0);
    expect(await count('issue_links')).toBe(0);
    const audit = (await ctx.db.all(`SELECT action FROM audit_log WHERE action LIKE 'issue.%' ORDER BY created_at, action`)).map(
      (a) => a.action,
    );
    expect(audit).toContain('issue.restored');
    expect(audit).toContain('issue.purged');
    const next = await create(bob, { title: 'New' });
    expect(next.key).toBe('WEB-5');
  });

  it('restores a story without its parent epic when the epic is gone', async () => {
    expect((await bob.client.del(`/api/issues/${story.key}`)).status).toBe(200);
    expect((await bob.client.del(`/api/issues/${epic.key}`)).status).toBe(200);
    const r = await bob.client.post(`/api/trash/${story.key}/restore`);
    expect(r.status).toBe(200);
    expect(r.body.parentDropped).toBe(epic.key);
    const back = (await bob.client.get(`/api/issues/${story.key}`)).body.issue;
    expect(back.parent).toBe(null);
    expect(back.history.some((h) => h.field === 'parent' && h.from === epic.key && h.to === null)).toBe(true);
    // the epic, restored later, does not get the story back
    expect((await bob.client.post(`/api/trash/${epic.key}/restore`)).status).toBe(200);
    expect((await bob.client.get(`/api/issues/${story.key}`)).body.issue.parent).toBe(null);
  });
});

describe('Trash permissions', () => {
  it('reporters see and restore their own items; project admins and admins see all; only admins delete forever', async () => {
    const mine = await create(carol, { title: 'Carol made this' });
    const bobs = await create(bob, { title: 'Bob made this' });
    expect((await carol.client.del(`/api/issues/${bobs.key}`)).status).toBe(403);
    expect((await carol.client.del(`/api/issues/${mine.key}`)).status).toBe(200);
    expect((await bob.client.del(`/api/issues/${bobs.key}`)).status).toBe(200);

    const c = (await carol.client.get('/api/trash')).body;
    expect(keys(c.items)).toEqual([mine.key]);
    expect(c.items[0].canPurge).toBe(false);
    expect(keys((await bob.client.get('/api/trash')).body.items).sort()).toEqual([mine.key, bobs.key].sort());
    expect(keys((await ctx.admin.get('/api/trash')).body.items).sort()).toEqual([mine.key, bobs.key].sort());
    expect((await dave.client.get('/api/trash')).body.items).toEqual([]);
    expect((await carol.client.get('/api/trash?project=NOPE')).body.items).toEqual([]);

    expect((await carol.client.post(`/api/trash/${bobs.key}/restore`)).status).toBe(403);
    expect((await dave.client.post(`/api/trash/${mine.key}/restore`)).status).toBe(403);
    expect((await carol.client.del(`/api/trash/${mine.key}`)).status).toBe(403);
    expect((await carol.client.post(`/api/trash/${mine.key}/restore`)).status).toBe(200);
    expect((await ctx.admin.del(`/api/trash/${bobs.key}`)).status).toBe(200);

    // a private project's Trash is invisible to non-members
    await bob.client.post('/api/projects', { key: 'sec', name: 'Secret', visibility: 'private' });
    const s = (await bob.client.post('/api/issues', { projectKey: 'SEC', title: 'Hidden' })).body.issue;
    await bob.client.del(`/api/issues/${s.key}`);
    expect(keys((await carol.client.get('/api/trash')).body.items)).not.toContain(s.key);
    expect((await carol.client.post(`/api/trash/${s.key}/restore`)).status).toBe(404);
  });
});

describe('bulk delete', () => {
  it('moves the selection to the Trash; sub-tasks selected with their parent go with it', async () => {
    const a = await create(bob, { title: 'A' });
    const s = await create(bob, { type: 'subtask', title: 'S', parentKey: a.key });
    const b = await create(bob, { title: 'B' });
    const r = await bob.client.post('/api/issues/bulk', { keys: [s.key, a.key, b.key], action: 'delete' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ updated: 3, skipped: 0 });
    for (const k of [a.key, s.key, b.key]) expect((await bob.client.get(`/api/issues/${k}`)).status).toBe(404);
    const t = (await bob.client.get('/api/trash')).body;
    expect(keys(t.items).sort()).toEqual([a.key, b.key].sort());
    expect(t.items.find((i) => i.key === a.key).subtasks).toBe(1);
    expect((await bob.client.post(`/api/trash/${a.key}/restore`)).status).toBe(200);
    expect((await bob.client.get(`/api/issues/${s.key}`)).status).toBe(200);
    // deleting an issue already in the Trash: not found
    const again = await bob.client.post('/api/issues/bulk', { keys: [b.key], action: 'delete' });
    expect(again.body.results).toEqual([{ key: b.key, ok: false, error: 'Issue not found' }]);
  });
});

describe('purge job', () => {
  const run = () => runDueJobs({ env: ctx.env, req: { url: 'https://tracker.example.com/api/x' } }, { force: 'trash_purge' });

  it('removes items older than trashDays for good, with their attachments and R2 files', async () => {
    const objects = new Map();
    ctx.env.FILES = {
      async put(k, v) {
        objects.set(k, v);
      },
      async get(k) {
        return objects.get(k) || null;
      },
      async delete(k) {
        objects.delete(k);
      },
    };
    const old = await create(bob, { title: 'Old' });
    const oldSub = await create(bob, { type: 'subtask', title: 'Old sub', parentKey: old.key });
    const recent = await create(bob, { title: 'Recent' });
    const live = await create(bob, { title: 'Live' });
    const t = new Date().toISOString();
    const ids = Object.fromEntries((await ctx.db.all('SELECT key, id FROM issues')).map((r) => [r.key, r.id]));
    await ctx.db.batch([
      {
        sql: `INSERT INTO attachments (id, issue_id, filename, content_type, size, storage, created_at) VALUES ('f-db', ?, 'a.txt', 'text/plain', 3, 'db', ?)`,
        params: [ids[old.key], t],
      },
      { sql: `INSERT INTO file_chunks (file_id, seq, data) VALUES ('f-db', 0, 'YWJj')`, params: [] },
      {
        sql: `INSERT INTO attachments (id, issue_id, filename, content_type, size, storage, created_at) VALUES ('f-r2', ?, 'b.txt', 'text/plain', 3, 'r2', ?)`,
        params: [ids[oldSub.key], t],
      },
      {
        sql: `INSERT INTO attachments (id, issue_id, filename, content_type, size, storage, created_at) VALUES ('f-keep', ?, 'c.txt', 'text/plain', 3, 'r2', ?)`,
        params: [ids[recent.key], t],
      },
    ]);
    objects.set('attachments/f-r2', new Uint8Array([1]));
    objects.set('attachments/f-keep', new Uint8Array([2]));
    await bob.client.del(`/api/issues/${old.key}`);
    await bob.client.del(`/api/issues/${recent.key}`);
    // "recent" went to the Trash 5 days after "old"
    await ctx.db.run('UPDATE issues SET deleted_at = ? WHERE key = ?', [new Date(Date.now() + 5 * 864e5).toISOString(), recent.key]);

    clockMs = Date.now() + 29 * 864e5; // nothing is 30 days old yet
    expect(await run()).toMatchObject({ ran: 'trash_purge', status: 'done', result: { purged: 0 } });

    clockMs = Date.now() + 31 * 864e5;
    const r = await run();
    expect(r).toMatchObject({ ran: 'trash_purge', status: 'done', result: { purged: 1, files: 1 } });
    expect(await count('issues WHERE key IN (?, ?)', [old.key, oldSub.key])).toBe(0);
    expect(await count('attachments WHERE id IN (?, ?)', ['f-db', 'f-r2'])).toBe(0);
    expect(await count('file_chunks')).toBe(0);
    expect([...objects.keys()]).toEqual(['attachments/f-keep']);
    expect(await count('issues WHERE key IN (?, ?)', [recent.key, live.key])).toBe(2);
    const audit = await ctx.db.all(`SELECT actor_id, details FROM audit_log WHERE action = 'issue.purged'`);
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_id).toBe(null);
    expect(JSON.parse(audit[0].details)).toMatchObject({ key: old.key, subtasks: 1 });

    // a longer trashDays keeps "recent" past its 30 days
    expect((await ctx.admin.patch('/api/admin/settings', { trashDays: 60 })).status).toBe(200);
    expect((await ctx.admin.patch('/api/admin/settings', { trashDays: 0 })).status).toBe(400);
    clockMs = Date.now() + 40 * 864e5;
    expect((await run()).result.purged).toBe(0);
    expect((await bob.client.get('/api/trash')).body.trashDays).toBe(60);
  });

  it('runs in parts when the query budget is small', async () => {
    for (let i = 0; i < 4; i++) {
      const x = await create(bob, { title: `T${i}` });
      await bob.client.del(`/api/issues/${x.key}`);
    }
    ctx.env.JOBS_MAX_QUERIES = 22;
    clockMs = Date.now() + 31 * 864e5;
    const first = await run();
    expect(first.status).toBe('partial');
    let r = first;
    for (let i = 0; i < 10 && r.status === 'partial'; i++) r = await run();
    expect(r.status).toBe('done');
    expect(r.result.purged).toBe(4);
    expect(await count('issues')).toBe(0);
  });
});
