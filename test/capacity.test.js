// Capacity planning: availability, time off, allocations, how remaining work is spread over weeks, privacy,
// CSV export, the sprint hint and backups.
import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser } from './helpers.js';
import { level, issueWindow, shares, weekdays, availability, weekList } from '../server/lib/capacity.js';
import { TABLES } from '../server/lib/backup.js';

const NOW = '2026-06-17T19:00:00.000Z'; // Wednesday, 12:00 in Vancouver (the default workspace time zone)
const TODAY = '2026-06-17';
const W0 = '2026-06-15';
const W1 = '2026-06-22';
let ctx, bob, carol, dave, gina;

async function issue(who, fields) {
  const r = await who.client.post('/api/issues', fields);
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.issue;
}
const person = (grid, id) => grid.people.find((p) => p.id === id);
const week = (p, start) => p.weeks.find((w) => w.start === start);

// WEB: Bob (project admin) and Carol (member), Gina a guest. OPS: Dave only (Bob shares nothing with him).
beforeEach(async () => {
  ctx = await withAdmin({ now: NOW });
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
  dave = await addUser(ctx, { email: 'dave@example.com', name: 'Dave' });
  gina = await addUser(ctx, { email: 'gina@client.example', name: 'Gina Guest', role: 'guest' });
  await bob.client.post('/api/projects', { key: 'WEB', name: 'Website', visibility: 'private' });
  await bob.client.put(`/api/projects/WEB/members/${carol.id}`, { role: 'member' });
  await bob.client.put(`/api/projects/WEB/members/${gina.id}`, { role: 'guest-comment' });
  await dave.client.post('/api/projects', { key: 'OPS', name: 'Ops', visibility: 'private' });
});

describe('capacity helpers', () => {
  it('levels, weekdays, windows and shares', () => {
    expect(level(10, 20)).toEqual({ pct: 50, level: 'light' });
    expect(level(14, 20).level).toBe('good');
    expect(level(20, 20).level).toBe('good');
    expect(level(22, 20).level).toBe('over');
    expect(level(25, 20).level).toBe('overloaded');
    expect(level(1, 0)).toEqual({ pct: null, level: 'overloaded' });
    expect(level(0, 0).level).toBe('none');
    expect(weekdays('2026-06-19', '2026-06-22')).toEqual(['2026-06-19', '2026-06-22']);
    expect(issueWindow({ due_date: '2026-06-19' }, TODAY).days).toHaveLength(3);
    expect(issueWindow({ start_date: '2026-06-22', due_date: '2026-06-23' }, TODAY).days).toEqual(['2026-06-22', '2026-06-23']);
    expect(issueWindow({ due_date: '2026-06-01' }, TODAY).days).toEqual([TODAY]); // overdue lands today
    expect(issueWindow({ due_date: '2026-06-20' }, '2026-06-20').days).toEqual(['2026-06-22']); // weekend: next weekday
    expect(issueWindow({ sprint_state: 'active', sprint_start: '2026-06-08', sprint_end: '2026-06-19' }, TODAY).days).toHaveLength(3);
    expect(issueWindow({ sprint_state: 'closed', sprint_end: '2026-06-19' }, TODAY).unscheduled).toBe(true);
    expect(issueWindow({}, TODAY).unscheduled).toBe(true);
    const one = shares([{ project_id: 'a', pct: null }]);
    expect(one.get('a')).toEqual({ share: 100, set: false });
    const mixed = shares([
      { project_id: 'a', pct: 60 },
      { project_id: 'b', pct: null },
      { project_id: 'c', pct: null },
    ]);
    expect(mixed.get('a')).toEqual({ share: 60, set: true });
    expect(mixed.get('b').share).toBe(20);
    const weeks = weekList(TODAY, 2);
    expect(weeks.map((w) => w.start)).toEqual([W0, W1]);
    expect(availability(weeks, TODAY, 8, [{ start_date: '2026-06-22', end_date: '2026-06-23' }])).toEqual([
      { available: 24, awayDays: 0 },
      { available: 24, awayDays: 2 },
    ]);
  });
});

describe('capacity grid', () => {
  it('spreads remaining work over weeks and buckets the rest', async () => {
    const sprint = (await bob.client.post('/api/projects/WEB/sprints', {})).body.sprint;
    expect((await bob.client.post(`/api/sprints/${sprint.id}/start`, { startDate: '2026-06-15', endDate: '2026-06-26' })).status).toBe(200);
    const due = await issue(bob, {
      projectKey: 'WEB',
      title: 'Due Friday',
      assigneeId: carol.id,
      estimateHours: 16,
      dueDate: '2026-06-19',
    });
    await issue(bob, { projectKey: 'WEB', title: 'In sprint', assigneeId: carol.id, estimateHours: 8, sprintId: sprint.id }); // 8 weekdays: 3 in W0, 5 in W1
    await issue(bob, { projectKey: 'WEB', title: 'No dates', assigneeId: carol.id, estimateHours: 5 });
    await issue(bob, { projectKey: 'WEB', title: 'No estimate', assigneeId: carol.id });
    await issue(bob, {
      projectKey: 'WEB',
      title: 'Far away',
      assigneeId: carol.id,
      estimateHours: 10,
      startDate: '2026-12-01',
      dueDate: '2026-12-02',
    });
    await issue(bob, { projectKey: 'WEB', title: 'Epic', type: 'epic', assigneeId: carol.id, estimateHours: 100 });
    const done = await issue(bob, { projectKey: 'WEB', title: 'Done', assigneeId: carol.id, estimateHours: 40, dueDate: '2026-06-18' });
    const statuses = (await bob.client.get('/api/projects/WEB')).body.project.statuses;
    await bob.client.patch(`/api/issues/${done.key}`, { statusId: statuses.find((s) => s.category === 'done').id });
    await carol.client.post(`/api/issues/${due.key}/worklogs`, { hours: 4 }); // 12 left

    const r = await carol.client.get('/api/capacity');
    expect(r.status).toBe(200);
    expect(r.body.weeks).toHaveLength(8);
    expect(r.body.today).toBe(TODAY);
    const c = person(r.body, carol.id);
    expect(c.weeklyHours).toBe(40);
    expect(week(c, W0)).toMatchObject({ available: 24, booked: 15, pct: 63, level: 'light' }); // 12 + 3 of the sprint issue
    expect(week(c, W1)).toMatchObject({ available: 40, booked: 5, level: 'light' });
    expect(c.unscheduled).toBe(5);
    expect(c.later).toBe(10);
    expect(c.unestimated).toBe(1);
    expect(c.issues.map((i) => i.title)).toEqual(['Due Friday', 'Far away', 'In sprint', 'No dates']);
    expect(c.issues[0]).toMatchObject({ remaining: 12, weeks: { [W0]: 12 } });
  });

  it('applies weekly hours and time off; notes only for the person and admins', async () => {
    expect((await bob.client.put(`/api/capacity/people/${carol.id}`, { weeklyHours: 20 })).status).toBe(403);
    expect((await carol.client.put('/api/capacity/people/me', { weeklyHours: 30 })).status).toBe(200);
    expect((await carol.client.put('/api/capacity/people/me', { weeklyHours: 300 })).status).toBe(400);
    expect((await carol.client.post('/api/capacity/people/me/time-off', { startDate: '2026-06-23', endDate: '2026-06-22' })).status).toBe(
      400,
    );
    const off = await carol.client.post('/api/capacity/people/me/time-off', {
      startDate: '2026-06-22',
      endDate: '2026-06-23',
      note: 'Dentist',
    });
    expect(off.status).toBe(201);
    expect((await bob.client.post(`/api/capacity/people/${carol.id}/time-off`, { startDate: '2026-07-01' })).status).toBe(403);
    expect((await ctx.admin.post(`/api/capacity/people/${carol.id}/time-off`, { startDate: '2026-07-01' })).status).toBe(201);

    const mine = person((await carol.client.get('/api/capacity')).body, carol.id);
    expect(mine.weeklyHours).toBe(30);
    expect(week(mine, W0).available).toBe(18);
    expect(week(mine, W1)).toMatchObject({ available: 18, awayDays: 2 });
    expect(mine.timeOff[0]).toMatchObject({ startDate: '2026-06-22', note: 'Dentist' });

    const seenByBob = person((await bob.client.get('/api/capacity')).body, carol.id);
    expect(week(seenByBob, W1).awayDays).toBe(2);
    expect(seenByBob.timeOff[0]).toEqual({ startDate: '2026-06-22', endDate: '2026-06-23', away: true });
    expect(JSON.stringify(seenByBob)).not.toContain('Dentist');
    expect(person((await ctx.admin.get('/api/capacity')).body, carol.id).timeOff[0].note).toBe('Dentist');

    expect((await bob.client.get(`/api/capacity/people/${carol.id}`)).status).toBe(403);
    expect((await bob.client.del(`/api/capacity/time-off/${off.body.timeOff.id}`)).status).toBe(404);
    expect((await carol.client.del(`/api/capacity/time-off/${off.body.timeOff.id}`)).status).toBe(200);
    expect((await carol.client.get('/api/capacity/people/me')).body).toMatchObject({ weeklyHours: 30, custom: true, defaultHours: 40 });
    expect((await carol.client.put('/api/capacity/people/me', { weeklyHours: null })).status).toBe(200);
    expect((await carol.client.get('/api/capacity/people/me')).body.custom).toBe(false);

    // the workspace default
    expect((await ctx.admin.patch('/api/admin/settings', { defaultCapacityHours: 500 })).status).toBe(400);
    expect((await ctx.admin.patch('/api/admin/settings', { defaultCapacityHours: 35 })).status).toBe(200);
    expect(person((await carol.client.get('/api/capacity')).body, carol.id).weeklyHours).toBe(35);
  });

  it("shows only people who share a project, hides other projects' issues, and 404s for guests", async () => {
    await ctx.admin.post('/api/projects', { key: 'SEC', name: 'Secret', visibility: 'private' });
    await ctx.admin.put(`/api/projects/SEC/members/${carol.id}`, { role: 'member' });
    await issue(
      { client: ctx.admin },
      { projectKey: 'SEC', title: 'Secret work', assigneeId: carol.id, estimateHours: 6, dueDate: '2026-06-19' },
    );
    const bobView = (await bob.client.get('/api/capacity')).body;
    expect(bobView.people.map((p) => p.name)).toEqual(['Bob', 'Carol']);
    const c = person(bobView, carol.id);
    expect(c.issues).toEqual([]);
    expect(c.elsewhere).toMatchObject({ count: 1, weeks: { [W0]: 6 } });
    expect(week(c, W0).booked).toBe(6); // counted, but not named
    expect(JSON.stringify(bobView)).not.toContain('Secret work');
    expect(person((await ctx.admin.get('/api/capacity')).body, carol.id).issues[0].title).toBe('Secret work');
    expect((await ctx.admin.get('/api/capacity')).body.people.map((p) => p.name)).toContain('Dave');
    expect((await bob.client.get('/api/capacity?team=OPS')).status).toBe(404);
    for (const path of [
      '/api/capacity',
      '/api/capacity/export.csv',
      '/api/capacity/people/me',
      '/api/projects/WEB/capacity',
      '/api/projects/WEB/sprint-capacity',
    ]) {
      expect((await gina.client.get(path)).status, path).toBe(404);
    }
  });

  it('uses project allocations in the project view', async () => {
    await bob.client.post('/api/projects', { key: 'APP', name: 'App', visibility: 'private' });
    await bob.client.put(`/api/projects/APP/members/${carol.id}`, { role: 'member' });
    await issue(bob, { projectKey: 'WEB', title: 'Web work', assigneeId: carol.id, estimateHours: 6, dueDate: '2026-06-19' });
    await issue(bob, { projectKey: 'APP', title: 'App work', assigneeId: carol.id, estimateHours: 3, dueDate: '2026-06-19' });

    let alloc = (await bob.client.get('/api/projects/WEB/capacity')).body;
    expect(alloc.members.find((m) => m.userId === carol.id)).toMatchObject({ pct: null, share: 50, projects: 2 });
    expect(alloc.members.map((m) => m.name)).not.toContain('Gina Guest');
    expect((await carol.client.put('/api/projects/WEB/capacity', { allocations: [{ userId: carol.id, pct: 70 }] })).status).toBe(403);
    expect((await bob.client.put('/api/projects/WEB/capacity', { allocations: [{ userId: gina.id, pct: 10 }] })).status).toBe(400);
    expect((await bob.client.put('/api/projects/WEB/capacity', { allocations: [{ userId: carol.id, pct: 120 }] })).status).toBe(400);
    expect((await bob.client.put('/api/projects/WEB/capacity', { allocations: [{ userId: carol.id, pct: 70 }] })).status).toBe(200);
    alloc = (await bob.client.get('/api/projects/APP/capacity')).body;
    expect(alloc.members.find((m) => m.userId === carol.id)).toMatchObject({ pct: null, share: 30, allocatedElsewhere: 70 });

    const web = (await bob.client.get('/api/capacity?project=WEB')).body;
    expect(web.project.key).toBe('WEB');
    expect(web.people.map((p) => p.name)).toEqual(['Bob', 'Carol']);
    const c = person(web, carol.id);
    expect(c).toMatchObject({ share: 70, shareSet: true });
    expect(week(c, W0)).toMatchObject({ available: 16.8, booked: 6 });
    expect(c.issues.map((i) => i.title)).toEqual(['Web work']);
    // team = WEB's people, every project's work
    const team = person((await bob.client.get('/api/capacity?team=WEB')).body, carol.id);
    expect(week(team, W0)).toMatchObject({ available: 24, booked: 9 });
    // role changes keep the allocation
    await bob.client.put(`/api/projects/WEB/members/${carol.id}`, { role: 'admin' });
    expect((await bob.client.get('/api/projects/WEB/capacity')).body.members.find((m) => m.userId === carol.id).pct).toBe(70);
    expect((await bob.client.put('/api/projects/WEB/capacity', { allocations: [{ userId: carol.id, pct: null }] })).status).toBe(200);
    expect(person((await bob.client.get('/api/capacity?project=WEB')).body, carol.id).share).toBe(50);
  });

  it('exports CSV and gives the sprint hint', async () => {
    const sprint = (await bob.client.post('/api/projects/WEB/sprints', {})).body.sprint;
    await bob.client.post(`/api/sprints/${sprint.id}/start`, { startDate: '2026-06-15', endDate: '2026-06-26' });
    const a = await issue(bob, { projectKey: 'WEB', title: 'Sprint work', assigneeId: carol.id, estimateHours: 30, sprintId: sprint.id });
    await issue(bob, { projectKey: 'WEB', title: 'Sprint, no estimate', sprintId: sprint.id });
    await carol.client.post(`/api/issues/${a.key}/worklogs`, { hours: 10 });
    await carol.client.post('/api/capacity/people/me/time-off', { startDate: '2026-06-22', endDate: '2026-06-22' });

    const hint = (await carol.client.get('/api/projects/WEB/sprint-capacity')).body.sprints[0];
    // Bob and Carol, today to 06-26: 8 weekdays x 8 h, Carol away one day
    expect(hint).toMatchObject({ id: sprint.id, from: TODAY, people: 2, available: 120, remaining: 20, unestimated: 1, level: 'light' });

    const csv = await bob.client.get('/api/capacity/export.csv?project=WEB');
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    const lines = csv.body.split('\n');
    expect(lines[0]).toBe('Person,Weekly hours,Allocation %,Week starting,Available hours,Booked hours,Percent booked,Level,Days away');
    expect(lines).toContain('Carol,40,100,2026-06-22,32,12.5,39,Light,1');
    expect(lines.some((l) => l.startsWith('Carol,40,100,Unscheduled'))).toBe(true);
  });

  it('is in backups', () => {
    for (const t of ['user_capacity', 'time_off', 'project_allocations'])
      expect(
        TABLES.some((x) => x.name === t),
        t,
      ).toBe(true);
  });
});
