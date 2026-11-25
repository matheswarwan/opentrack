import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser } from './helpers.js';

const DAY = 864e5;
const BASE = Math.floor(Date.now() / DAY) * DAY - 20 * DAY; // 00:00 UTC, 20 days ago
const at = (d, h = 10) => new Date(BASE + d * DAY + h * 3600e3).toISOString();
const date = (d) => new Date(BASE + d * DAY).toISOString().slice(0, 10);
const weekStart = (iso) => {
  const t = Math.floor(Date.parse(iso) / DAY) * DAY;
  return new Date(t - ((new Date(t).getUTCDay() + 6) % 7) * DAY).toISOString().slice(0, 10);
};

let ctx, bob, carol, proj, st;
beforeEach(async () => {
  ctx = await withAdmin();
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
  proj = (await bob.client.post('/api/projects', { key: 'WEB', name: 'Website' })).body.project;
  st = Object.fromEntries(proj.statuses.map((s) => [s.name, s.id]));
});

/**
 * Run an API step, then backdate every row it wrote (history, new issues, resolutions, audit rows,
 * sprint completion) to `t`. Earlier steps are already backdated, so ">= the real time before the
 * step" only picks up this step's rows.
 */
async function step(t, fn) {
  const real = new Date().toISOString();
  const r = await fn();
  const db = ctx.db;
  await db.run('UPDATE issue_history SET created_at = ? WHERE created_at >= ?', [t, real]);
  await db.run('UPDATE issues SET created_at = ?, updated_at = ? WHERE created_at >= ?', [t, t, real]);
  await db.run('UPDATE issues SET resolved_at = ? WHERE resolved_at >= ?', [t, real]);
  await db.run('UPDATE audit_log SET created_at = ? WHERE created_at >= ?', [t, real]);
  await db.run('UPDATE sprints SET completed_at = ? WHERE completed_at >= ?', [t, real]);
  return r;
}

const create = async (data) => {
  const r = await bob.client.post('/api/issues', { projectKey: 'WEB', ...data });
  expect(r.status).toBe(201);
  return r.body.issue.key;
};
const patch = async (key, data) => expect((await bob.client.patch(`/api/issues/${key}`, data)).status).toBe(200);

/**
 * Sprint S1 (days 1 to 5): A 3, B 5, C 2 committed. A done day 2. D (8) added day 3, B re-estimated
 * 5 -> 3 day 3. C removed day 4. B done day 5. Completed day 5 18:00 with D unfinished (moved out).
 * Sprint S2 (days 7 to 9): D (8), done day 8. F created done day 8. G open bug for Carol, day 10.
 */
async function build() {
  const s1 = (await bob.client.post('/api/projects/WEB/sprints', { name: 'S1', startDate: date(1), endDate: date(5) })).body.sprint;
  const k = {};
  await step(at(0), async () => {
    k.A = await create({ title: 'A', storyPoints: 3, sprintId: s1.id });
    k.B = await create({ title: 'B', storyPoints: 5, sprintId: s1.id });
    k.C = await create({ title: 'C', storyPoints: 2, sprintId: s1.id });
    k.D = await create({ title: 'D', storyPoints: 8 });
  });
  await step(at(1), () => bob.client.post(`/api/sprints/${s1.id}/start`, {}));
  await step(at(2, 9), () => patch(k.A, { statusId: st['In Progress'] }));
  await step(at(2, 21), () => patch(k.A, { statusId: st.Done }));
  await step(at(3, 10), () => patch(k.D, { sprintId: s1.id }));
  await step(at(3, 11), () => patch(k.B, { storyPoints: 3 }));
  await step(at(4, 10), () => patch(k.B, { statusId: st['In Progress'] }));
  await step(at(4, 11), () => patch(k.C, { sprintId: null }));
  await step(at(5, 10), () => patch(k.B, { statusId: st.Done }));
  const comp = await step(at(5, 18), () => bob.client.post(`/api/sprints/${s1.id}/complete`, {}));
  expect(comp.body.movedIssues).toBe(1);

  const s2 = (await bob.client.post('/api/projects/WEB/sprints', { name: 'S2', startDate: date(7), endDate: date(9) })).body.sprint;
  await step(at(6), () => patch(k.D, { sprintId: s2.id }));
  await step(at(7, 9), () => bob.client.post(`/api/sprints/${s2.id}/start`, {}));
  await step(at(7, 12), () => patch(k.D, { statusId: st['In Progress'] }));
  await step(at(8, 12), () => patch(k.D, { statusId: st.Done }));
  await step(at(8, 13), async () => {
    k.F = await create({ title: 'F', storyPoints: 1, statusId: st.Done });
  });
  await step(at(9, 18), () => bob.client.post(`/api/sprints/${s2.id}/complete`, {}));
  await step(at(10), async () => {
    k.G = await create({ title: 'G', type: 'bug', priority: 'high', statusId: st['In Progress'], assigneeId: carol.id });
  });
  return { s1, s2, k };
}

describe('reports', () => {
  it('rebuilds the sprint burndown from history', async () => {
    const { s1, k } = await build();
    const r = await bob.client.get(`/api/projects/WEB/reports?sprint=${s1.id}`);
    expect(r.status).toBe(200);
    const b = r.body.burndown;
    expect(b.sprint.name).toBe('S1');
    expect(b.startedAt).toBe(at(1));
    expect(b.start).toEqual({ points: 10, issues: 3 });
    expect(b.days.map((d) => d.date)).toEqual([1, 2, 3, 4, 5].map(date));
    expect(b.days.map((d) => d.remainingPoints)).toEqual([10, 7, 13, 11, 8]);
    expect(b.days.map((d) => d.remainingIssues)).toEqual([3, 2, 3, 2, 1]);
    expect(b.days.map((d) => d.idealPoints)).toEqual([8, 6, 4, 2, 0]);
    expect(b.scopeChanges.map((c) => [c.key, c.change, c.date, c.points])).toEqual([
      [k.D, 'added', date(3), 8],
      [k.B, 'points', date(3), -2],
      [k.C, 'removed', date(4), 2],
    ]);
    expect(b.totals).toMatchObject({
      committedPoints: 10,
      addedPoints: 8,
      removedPoints: 2,
      estimateChangePoints: -2,
      completedPoints: 6,
      completedIssues: 2,
      remainingPoints: 8,
      remainingIssues: 1,
    });
    // default sprint: no active sprint, so the last closed one
    expect((await bob.client.get('/api/projects/WEB/reports')).body.burndown.sprint.name).toBe('S2');
    expect(r.body.sprints.map((s) => s.name)).toEqual(['S2', 'S1']);
    expect((await bob.client.get('/api/projects/WEB/reports?sprint=nope')).status).toBe(404);
  });

  it('computes velocity, created vs resolved, cycle time and breakdown', async () => {
    const { k } = await build();
    const r = (await bob.client.get('/api/projects/WEB/reports?weeks=8')).body;
    expect(
      r.velocity.sprints.map((v) => [v.sprint.name, v.committedPoints, v.completedPoints, v.committedIssues, v.completedIssues]),
    ).toEqual([
      ['S1', 10, 6, 3, 2],
      ['S2', 8, 8, 1, 1],
    ]);
    expect(r.velocity.averageCompletedPoints).toBe(7);

    expect(r.flow.weeks).toHaveLength(8);
    expect(r.flow.totals).toEqual({ created: 6, resolved: 4 });
    const expected = {};
    for (const [t, kind] of [
      [at(0), 'created'],
      [at(0), 'created'],
      [at(0), 'created'],
      [at(0), 'created'],
      [at(8, 13), 'created'],
      [at(10), 'created'],
      [at(2, 21), 'resolved'],
      [at(5, 10), 'resolved'],
      [at(8, 12), 'resolved'],
      [at(8, 13), 'resolved'],
    ]) {
      const w = (expected[weekStart(t)] ||= { created: 0, resolved: 0 });
      w[kind]++;
    }
    for (const w of r.flow.weeks)
      expect({ created: w.created, resolved: w.resolved }).toEqual(expected[w.start] || { created: 0, resolved: 0 });

    // A 0.5 d, B 1 d (In Progress day 4 10:00 to Done day 5 10:00), D 1 d, F 0 d (created done: falls back to created_at)
    expect(r.cycleTime).toMatchObject({ issues: 4, medianDays: 0.8, p85Days: 1 });
    expect(r.cycleTime.buckets.slice(0, 2).map((x) => x.count)).toEqual([2, 2]);
    expect(r.cycleTime.slowest.find((x) => x.key === k.F)).toMatchObject({ days: 0, startedFrom: 'created' });

    expect(r.breakdown.open).toBe(2);
    expect(r.breakdown.byStatus.map((s) => [s.name, s.count])).toEqual([
      ['To Do', 1],
      ['In Progress', 1],
      ['In Review', 0],
    ]);
    expect(r.breakdown.byAssignee.map((a) => [a.name, a.count])).toEqual([
      ['Carol', 1],
      ['Unassigned', 1],
    ]);
    expect(r.breakdown.byType).toEqual([
      { type: 'task', count: 1 },
      { type: 'bug', count: 1 },
    ]);
    expect(r.breakdown.byPriority).toEqual([
      { priority: 'high', count: 1 },
      { priority: 'medium', count: 1 },
    ]);
  });

  it('shows an active sprint up to today and explains empty states', async () => {
    const empty = (await bob.client.get('/api/projects/WEB/reports')).body;
    expect(empty.burndown).toEqual({ sprint: null, empty: 'no_sprint' });
    expect(empty.velocity.sprints).toEqual([]);
    const today = new Date().toISOString().slice(0, 10);
    const end = new Date(Date.now() + 6 * DAY).toISOString().slice(0, 10);
    const s = (await bob.client.post('/api/projects/WEB/sprints', { name: 'Now' })).body.sprint;
    expect((await bob.client.get(`/api/projects/WEB/reports?sprint=${s.id}`)).body.burndown.empty).toBe('not_started');
    await create({ title: 'X', storyPoints: 2, sprintId: s.id });
    await bob.client.post(`/api/sprints/${s.id}/start`, { startDate: today, endDate: end });
    const b = (await bob.client.get('/api/projects/WEB/reports')).body.burndown;
    expect(b.sprint).toMatchObject({ name: 'Now', state: 'active' });
    expect(b.days).toHaveLength(7);
    expect(b.days[0]).toMatchObject({ date: today, remainingPoints: 2, remainingIssues: 1 });
    expect(b.days[6].remainingPoints).toBeNull();
    expect(b.days[6].idealPoints).toBe(0);
  });

  it('follows project permissions', async () => {
    await bob.client.patch('/api/projects/WEB', { visibility: 'private' });
    expect((await carol.client.get('/api/projects/WEB/reports')).status).toBe(404);
    expect((await ctx.admin.get('/api/projects/WEB/reports')).status).toBe(200);
    await bob.client.put(`/api/projects/WEB/members/${carol.id}`, { role: 'viewer' });
    expect((await carol.client.get('/api/projects/WEB/reports')).status).toBe(200);
  });

  it('is available as the MCP tool project_report', async () => {
    const { k } = await build();
    const token = (await bob.client.post('/api/me/tokens', { name: 'Claude' })).body.token;
    let id = 0;
    const tool = async (args) => {
      const res = await ctx.app.request(
        'http://t.example/mcp',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: 'project_report', arguments: args } }),
        },
        ctx.env,
      );
      const out = (await res.json()).result;
      return out.isError ? { error: out.content[0].text } : JSON.parse(out.content[0].text);
    };
    const v = await tool({ project: 'WEB', kind: 'velocity' });
    expect(v.report.sprints.map((x) => x.completedPoints)).toEqual([6, 8]);
    const b = await tool({ project: 'web', kind: 'burndown', sprint: 's1' });
    expect(b.report.days.map((d) => d.remainingPoints)).toEqual([10, 7, 13, 11, 8]);
    expect(b.sprints).toEqual(['S2', 'S1']);
    const br = await tool({ project: 'WEB', kind: 'breakdown' });
    expect(br.report.open).toBe(2);
    expect((await tool({ project: 'WEB', kind: 'cycle_time' })).report.medianDays).toBe(0.8);
    expect((await tool({ project: 'WEB', kind: 'nope' })).error).toMatch(/kind must be/);
    expect((await tool({ project: 'WEB', kind: 'burndown', sprint: 'S9' })).error).toMatch(/No started sprint/);
    expect(k.A).toBe('WEB-1');
  });
});
