// Hot paths read the issue once: updateIssue, the bulk edit and the board move (server/lib/issues/write.js,
// routes/bulk.js, routes/issues.js), and the move saves the rank in the same batch as the change.
import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser } from './helpers.js';
import { splitFullRow } from '../server/lib/issues/model.js';

let ctx, bob, st, sql, batches;
const ISSUE_READ = /FROM issues i JOIN projects p|SELECT \* FROM issues WHERE id/;

beforeEach(async () => {
  ctx = await withAdmin();
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  const p = (await bob.client.post('/api/projects', { key: 'WEB', name: 'Website' })).body.project;
  st = Object.fromEntries(p.statuses.map((s) => [s.name, s.id]));
  // record every statement from here on
  sql = [];
  batches = [];
  const db = ctx.env.db;
  const wrap = (fn) => async (q, params) => {
    sql.push(q);
    return fn(q, params);
  };
  ctx.env.db = {
    ...db,
    all: wrap(db.all.bind(db)),
    get: wrap(db.get.bind(db)),
    run: wrap(db.run.bind(db)),
    batch: async (s) => {
      batches.push(s.map((x) => x.sql));
      return db.batch(s);
    },
  };
});

const make = async (data = {}) => (await bob.client.post('/api/issues', { projectKey: 'WEB', title: 'Task', ...data })).body.issue;
const issueReads = () =>
  sql.filter((q) => ISSUE_READ.test(q) && /WHERE \(i\.key = \?|WHERE i\.id = \?|SELECT \* FROM issues/.test(q)).length;

describe('splitFullRow', () => {
  it('gives the list shape (live parent) and the stored row', () => {
    const { row, current } = splitFullRow({ id: 'i1', parent_id: 'gone', live_parent_id: null, description: 'text', status_name: 'To Do' });
    expect(row.parent_id).toBe(null);
    expect(current.parent_id).toBe('gone');
    expect(current.description).toBe('text');
    expect(row.status_name).toBe('To Do');
  });
});

describe('one load per write', () => {
  it('PATCH reads the issue once before the write and once after', async () => {
    const a = await make({ description: 'before' });
    sql.length = 0;
    const r = await bob.client.patch(`/api/issues/${a.key}`, { title: 'Renamed', description: 'after' });
    expect(r.status).toBe(200);
    expect(r.body.issue.title).toBe('Renamed');
    expect(r.body.changed).toEqual(['title', 'description']);
    expect(issueReads()).toBe(2);
  });

  it('an unchanged description is still compared with the stored one', async () => {
    const a = await make({ description: 'same' });
    const r = await bob.client.patch(`/api/issues/${a.key}`, { description: 'same' });
    expect(r.body.changed).toEqual([]);
  });

  it('a parent in the Trash still counts as the stored parent', async () => {
    const epic = await make({ type: 'epic', title: 'Epic' });
    const child = await make({ parentKey: epic.key });
    await bob.client.del(`/api/issues/${epic.key}`);
    expect((await bob.client.get(`/api/issues/${child.key}`)).body.issue.parent).toBe(null);
    // clearing the parent is a change (the stored parent_id is still set), written to history with no key for the old one
    const r = await bob.client.patch(`/api/issues/${child.key}`, { parentKey: null });
    expect(r.status).toBe(200);
    expect(r.body.changed).toEqual(['parent']);
  });

  it('a bulk edit with label and list changes loads each issue once before its write', async () => {
    const keys = [];
    for (let i = 0; i < 3; i++) keys.push((await make({ labels: ['a'] })).key);
    sql.length = 0;
    const r = await bob.client.post('/api/issues/bulk', {
      keys,
      changes: { addLabels: ['b'], removeLabels: ['a'], priority: 'high', addComponents: [] },
    });
    expect(r.status).toBe(200);
    expect(r.body.updated).toBe(3);
    expect(issueReads()).toBe(6); // per key: one load, one read of the result
    const got = await bob.client.get(`/api/issues/${keys[0]}`);
    expect(got.body.issue.labels).toEqual(['b']);
    expect(got.body.issue.priority).toBe('high');
  });
});

describe('board move', () => {
  it('saves the rank in the same batch as the status change', async () => {
    const a = await make();
    const b = await make();
    sql.length = 0;
    batches.length = 0;
    const r = await bob.client.post(`/api/issues/${a.key}/move`, { statusId: st['In Progress'], prevKey: b.key });
    expect(r.status).toBe(200);
    expect(r.body.issue.status.name).toBe('In Progress');
    expect(r.body.issue.rank).toBe(b.rank + 1000);
    expect(r.body.changed).toEqual(['status']);
    const update = batches.flat().filter((q) => q.startsWith('UPDATE issues SET'));
    expect(update).toEqual(['UPDATE issues SET status_id = ?, resolved_at = ?, rank = ?, updated_at = ? WHERE id = ?']);
    expect(sql.filter((q) => q.startsWith('UPDATE issues SET rank'))).toEqual([]);
    expect(issueReads()).toBe(2);
    expect((await bob.client.get(`/api/issues/${a.key}`)).body.issue.rank).toBe(b.rank + 1000);
  });

  it('saves the rank when the patch changes nothing else', async () => {
    const a = await make();
    const b = await make();
    const r = await bob.client.post(`/api/issues/${a.key}/move`, { sprintId: 'backlog', prevKey: b.key });
    expect(r.status).toBe(200);
    expect(r.body.changed).toEqual([]);
    expect(r.body.issue.rank).toBe(b.rank + 1000);
    expect(r.body.issue.updatedAt).toBe(a.updatedAt); // a rank change alone is not an edit
  });

  it('a refused move leaves the rank alone', async () => {
    const a = await make();
    const b = await make();
    const r = await bob.client.post(`/api/issues/${a.key}/move`, { statusId: 'no-such-status', prevKey: b.key });
    expect(r.status).toBe(400);
    expect((await bob.client.get(`/api/issues/${a.key}`)).body.issue.rank).toBe(a.rank);
  });
});
