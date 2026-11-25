import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser } from './helpers.js';
import { runDueJobs, resetJobThrottle } from '../server/lib/jobs.js';
import { localMidnight } from '../server/lib/time.js';
import { matches, nextDates, describeSchedule, describeRule, renderTitle, isoWeek, dueDates } from '../server/lib/recurring.js';

// Local times in Vancouver (the default timeZone).
const at = (date, h) => localMidnight(date, 'America/Vancouver') + h * 3600e3;
const THU = '2026-11-19'; // a Thursday

describe('schedule maths', () => {
  it('daily, with and without weekends', () => {
    expect(matches({ freq: 'daily' }, '2026-11-21')).toBe(true); // Saturday
    expect(matches({ freq: 'daily', weekdaysOnly: true }, '2026-11-21')).toBe(false);
    expect(matches({ freq: 'daily', weekdaysOnly: true }, '2026-11-23')).toBe(true); // Monday
    const r = { schedule: { freq: 'daily', weekdaysOnly: true }, startDate: '2026-11-20' };
    expect(nextDates(r, '2026-11-20', 3)).toEqual(['2026-11-20', '2026-11-23', '2026-11-24']);
  });

  it('weekly on chosen weekdays', () => {
    const r = { schedule: { freq: 'weekly', weekdays: [1, 4] }, startDate: '2026-11-01' };
    expect(nextDates(r, '2026-11-19', 4)).toEqual(['2026-11-19', '2026-11-23', '2026-11-26', '2026-11-30']);
    expect(describeSchedule(r.schedule)).toBe('Every Monday and Thursday');
    expect(describeSchedule({ freq: 'weekly', weekdays: [0, 1, 3] })).toBe('Every Monday, Wednesday and Sunday');
    expect(describeSchedule({ freq: 'weekly', weekdays: [1, 2, 3, 4, 5] })).toBe('Every weekday (Monday to Friday)');
  });

  it('monthly on day N, the last day and the last weekday, including February', () => {
    const day31 = { schedule: { freq: 'monthly', monthly: 'day', day: 31 }, startDate: '2027-01-01' };
    expect(nextDates(day31, '2027-01-01', 4)).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
    const last = { schedule: { freq: 'monthly', monthly: 'last_day' }, startDate: '2028-01-01' };
    expect(nextDates(last, '2028-01-01', 3)).toEqual(['2028-01-31', '2028-02-29', '2028-03-31']); // 2028 is a leap year
    // last weekday: 2026-11-30 is a Monday; 2027-01-31 is a Sunday, so Friday the 29th; 2027-02-28 is a Sunday: the 26th
    const lw = { schedule: { freq: 'monthly', monthly: 'last_weekday' }, startDate: '2026-11-01' };
    expect(nextDates(lw, '2026-11-01', 4)).toEqual(['2026-11-30', '2026-12-31', '2027-01-29', '2027-02-26']);
    expect(describeSchedule({ freq: 'monthly', monthly: 'day', day: 30 })).toBe('Every month on day 30 (the last day in shorter months)');
  });

  it('yearly, with 29 February in other years', () => {
    const r = { schedule: { freq: 'yearly', month: 2, day: 29 }, startDate: '2026-01-01' };
    expect(nextDates(r, '2026-01-01', 3)).toEqual(['2026-02-28', '2027-02-28', '2028-02-29']);
    expect(describeSchedule({ freq: 'yearly', month: 11, day: 24 })).toBe('Every year on 24 November');
  });

  it('stops at the end date and the count', () => {
    const r = { schedule: { freq: 'daily' }, startDate: '2026-11-19', endDate: '2026-11-21' };
    expect(nextDates(r, '2026-11-19', 5)).toEqual(['2026-11-19', '2026-11-20', '2026-11-21']);
    const c = { schedule: { freq: 'daily' }, startDate: '2026-11-19', maxCount: 3, createdCount: 1 };
    expect(nextDates(c, '2026-11-19', 5)).toEqual(['2026-11-19', '2026-11-20']);
    expect(describeRule({ ...r, maxCount: 3 })).toBe('Every day, until 21 Nov 2026, 3 issues at most');
    expect(nextDates({ ...r, startDate: '2026-12-01', endDate: null }, '2026-11-19', 1)).toEqual(['2026-12-01']);
  });

  it('fills the title tokens', () => {
    expect(isoWeek('2026-11-19')).toBe(47);
    expect(isoWeek('2027-01-01')).toBe(53); // a Friday: still week 53 of 2026
    expect(renderTitle('Report {date} ({month} {year}, week {week})', '2026-11-19')).toBe('Report 2026-11-19 (November 2026, week 47)');
  });

  it('works out the catch-up window', () => {
    const rule = {
      schedule: JSON.stringify({ freq: 'daily' }),
      start_date: '2026-11-01',
      end_date: null,
      max_count: null,
      created_count: 0,
      created_at: '2026-10-01T12:00:00Z',
    };
    expect(dueDates(rule, THU, 'America/Vancouver')).toHaveLength(8); // today and 7 days back
    expect(dueDates({ ...rule, created_at: '2026-11-18T20:00:00Z' }, THU, 'America/Vancouver')).toEqual(['2026-11-18', THU]);
    expect(dueDates({ ...rule, max_count: 5, created_count: 3 }, THU, 'America/Vancouver')).toEqual(['2026-11-12', '2026-11-13']);
    expect(dueDates(rule, THU, 'America/Vancouver', new Set(['2026-11-12', THU]))).toHaveLength(6);
  });
});

let ctx, bob, carol, dave, clockMs;
const run = () => runDueJobs({ env: ctx.env, req: { url: 'https://tracker.example.com/api/x' } }, { force: 'recurring' });
/** Force runs until the job is done (a run stops early when its query budget runs low). */
async function runAll() {
  let r;
  for (let i = 0; i < 20; i++) {
    r = await run();
    if (r.status !== 'partial') return r;
  }
  return r;
}
const base = '/api/projects/WEB/recurring';
const weekly = { freq: 'weekly', weekdays: [1, 4] };

async function makeRule(c, data = {}) {
  const r = await c.post(base, {
    name: 'Weekly check',
    title: 'Check {date}',
    schedule: { freq: 'daily' },
    startDate: '2026-11-01',
    ...data,
  });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  // pretend the rule was made a while ago, so the catch-up window is not cut short
  await ctx.db.run('UPDATE recurring_rules SET created_at = ? WHERE id = ?', ['2026-10-01T12:00:00.000Z', r.body.rule.id]);
  return r.body.rule;
}
const issues = () =>
  ctx.db.all(
    `SELECT i.key, i.title, i.type, i.parent_id, i.due_date, i.sprint_id, i.assignee_id, i.reporter_id FROM issues i ORDER BY i.number`,
  );

beforeEach(async () => {
  clockMs = at(THU, 7);
  resetJobThrottle();
  ctx = await withAdmin({ now: () => clockMs });
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
  dave = await addUser(ctx, { email: 'dave@example.com', name: 'Dave', role: 'viewer' });
  await bob.client.post('/api/projects', { key: 'web', name: 'Website' });
});

describe('recurring rules API', () => {
  it('creates, previews, edits, pauses and deletes a rule', async () => {
    const rule = await makeRule(bob.client, { schedule: weekly, priority: 'high', labels: ['ops'], dueDays: 3 });
    expect(rule).toMatchObject({
      name: 'Weekly check',
      summary: 'Every Monday and Thursday',
      canManage: true,
      paused: false,
      dueDays: 3,
      labels: ['ops'],
    });
    const p = await bob.client.get(`${base}/${rule.id}/preview`);
    expect(p.body.dates).toEqual(['2026-11-19', '2026-11-23', '2026-11-26', '2026-11-30', '2026-12-03']);
    const draft = await bob.client.post(`${base}/preview`, { schedule: { freq: 'monthly', monthly: 'last_day' }, startDate: '2026-11-01' });
    expect(draft.body).toMatchObject({
      summary: 'Every month on the last day',
      dates: ['2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28', '2027-03-31'],
    });
    expect((await bob.client.patch(`${base}/${rule.id}`, { paused: true })).body.rule.paused).toBe(true);
    expect((await bob.client.get(`${base}/${rule.id}/preview`)).body).toMatchObject({ paused: true, dates: [] });
    const list = await bob.client.get(base);
    expect(list.body.rules).toHaveLength(1);
    expect((await bob.client.del(`${base}/${rule.id}`)).status).toBe(200);
    expect((await bob.client.get(base)).body.rules).toHaveLength(0);
  });

  it('checks the input', async () => {
    const bad = (data) => bob.client.post(base, { title: 'x', schedule: { freq: 'daily' }, ...data }).then((r) => r.status);
    expect(await bad({ schedule: { freq: 'weekly', weekdays: [] } })).toBe(400);
    expect(await bad({ schedule: { freq: 'monthly', monthly: 'day', day: 32 } })).toBe(400);
    expect(await bad({ schedule: { freq: 'yearly', month: 2, day: 30 } })).toBe(400);
    expect(await bad({ type: 'subtask' })).toBe(400);
    expect(await bad({ type: 'epic', subtasks: ['a'] })).toBe(400);
    expect(await bad({ startDate: '2026-12-01', endDate: '2026-11-01' })).toBe(400);
    expect(await bad({ maxCount: 0 })).toBe(400);
    expect(await bad({ dueDays: -1 })).toBe(400);
    expect(await bad({ title: '' })).toBe(400);
    expect(await bad({ templateId: 'nope' })).toBe(400);
    expect(await bad({})).toBe(201); // the name defaults to the title
  });

  it('lets members manage their own rules and project admins every rule', async () => {
    const mine = await makeRule(carol.client, { name: 'Carol rule' });
    const bobs = await makeRule(bob.client, { name: 'Bob rule' });
    const list = (await carol.client.get(base)).body.rules;
    expect(list.find((r) => r.id === mine.id).canManage).toBe(true);
    expect(list.find((r) => r.id === bobs.id).canManage).toBe(false);
    expect((await carol.client.patch(`${base}/${bobs.id}`, { paused: true })).status).toBe(403);
    expect((await carol.client.del(`${base}/${bobs.id}`)).status).toBe(403);
    expect((await carol.client.patch(`${base}/${mine.id}`, { name: 'Renamed' })).status).toBe(200);
    expect((await bob.client.patch(`${base}/${mine.id}`, { paused: true })).status).toBe(200);
    // a workspace viewer can read but not create
    expect((await dave.client.get(base)).status).toBe(200);
    expect((await dave.client.post(base, { title: 'x', schedule: { freq: 'daily' } })).status).toBe(403);
    // members-only project: outsiders see nothing
    await bob.client.patch('/api/projects/WEB', { visibility: 'private' });
    expect((await carol.client.get(base)).status).toBe(404);
    expect((await carol.client.get(`${base}/${mine.id}`)).status).toBe(404);
    expect((await carol.client.patch(`${base}/${mine.id}`, { paused: false })).status).toBe(404);
  });
});

describe('recurring job', () => {
  it('creates the due issues once, with tokens, due date, labels, a history line and a link back to the rule', async () => {
    const rule = await makeRule(bob.client, {
      name: 'Ops check',
      title: 'Ops check {date} wk{week}',
      schedule: weekly,
      startDate: '2026-11-16',
      dueDays: 3,
      labels: ['ops'],
      assigneeId: carol.id,
      priority: 'high',
    });
    const r = await run();
    expect(r).toMatchObject({ ran: 'recurring', status: 'done', result: { created: 2 } }); // Monday 16th and Thursday 19th
    const rows = await issues();
    expect(rows.map((i) => i.title)).toEqual(['Ops check 2026-11-16 wk47', 'Ops check 2026-11-19 wk47']);
    expect(rows.map((i) => i.due_date)).toEqual(['2026-11-19', '2026-11-22']);
    expect(rows[0]).toMatchObject({ assignee_id: carol.id, reporter_id: bob.id, sprint_id: null });
    const detail = (await bob.client.get(`/api/issues/${rows[1].key}`)).body.issue;
    expect(detail).toMatchObject({ labels: ['ops'], priority: 'high', recurring: { id: rule.id, name: 'Ops check' } });
    expect(detail.history.find((h) => h.field === 'recurring').to).toBe('Created by recurring rule Ops check');
    // the assignee was told
    expect(await ctx.db.all(`SELECT * FROM notifications WHERE user_id = ? AND type = 'assigned'`, [carol.id])).toHaveLength(2);
    // a second run (or a run the next minute) makes nothing new
    expect((await run()).result.created).toBe(0);
    expect(await issues()).toHaveLength(2);
    // run history
    const h = await bob.client.get(`${base}/${rule.id}`);
    expect(h.body.runs.map((x) => x.key)).toEqual([rows[1].key, rows[0].key]);
    expect(h.body.rule).toMatchObject({ createdCount: 2, lastCreatedOn: THU, nextOn: '2026-11-23' });
  });

  it('catches up at most 7 days back and never twice for one date', async () => {
    await makeRule(bob.client, { schedule: { freq: 'daily' }, startDate: '2026-10-01' });
    expect(await runAll()).toMatchObject({ status: 'done', result: { created: 8 } });
    // the unique (rule, date) pair stops a second copy even when the job is fooled into trying again
    const rule = await ctx.db.get('SELECT * FROM recurring_rules');
    const { createOccurrence, RULE_JOB_SELECT } = await import('../server/lib/recurring.js');
    const row = await ctx.db.get(`${RULE_JOB_SELECT} WHERE r.id = ?`, [rule.id]);
    expect(await createOccurrence(ctx.db, row, THU, new Date().toISOString())).toEqual({ skipped: 'already created' });
    expect(await issues()).toHaveLength(8);
    // the next day: one more
    clockMs = at('2026-11-20', 7);
    expect((await run()).result.created).toBe(1);
  });

  it('skips paused, ended and used-up rules, and archived projects', async () => {
    const paused = await makeRule(bob.client, { name: 'paused' });
    await bob.client.patch(`${base}/${paused.id}`, { paused: true });
    await makeRule(bob.client, { name: 'ended', endDate: '2026-11-05' });
    await makeRule(bob.client, { name: 'two', maxCount: 2 });
    await makeRule(bob.client, { name: 'later', startDate: '2026-12-01' });
    expect((await run()).result.created).toBe(2);
    expect((await issues()).map((i) => i.title)).toEqual(['Check 2026-11-12', 'Check 2026-11-13']);
    clockMs = at('2026-11-20', 7);
    expect((await run()).result.created).toBe(0);
    await bob.client.patch(`${base}/${paused.id}`, { paused: false });
    await bob.client.patch('/api/projects/WEB', { archived: true });
    expect((await run()).result.created).toBe(0);
  });

  it('adds the template and its sub-tasks, and puts the issue in the active sprint', async () => {
    const tpl = (
      await bob.client.post('/api/projects/WEB/templates', {
        name: 'Release',
        type: 'task',
        titlePrefix: '[Release] ',
        description: 'Steps',
        labels: ['release'],
        subtasks: ['Tag', 'Deploy'],
      })
    ).body.template;
    const sprint = (await bob.client.post('/api/projects/WEB/sprints', {})).body.sprint;
    await bob.client.post(`/api/sprints/${sprint.id}/start`, { startDate: '2026-11-16', endDate: '2026-11-30' });
    await makeRule(bob.client, {
      title: 'Release {month}',
      templateId: tpl.id,
      subtasks: ['Notes'],
      sprint: 'active',
      startDate: THU,
      schedule: { freq: 'monthly', monthly: 'day', day: 19 },
    });
    expect((await run()).result.created).toBe(1);
    const rows = await issues();
    expect(rows.map((i) => [i.title, i.type])).toEqual([
      ['[Release] Release November', 'task'],
      ['Tag', 'subtask'],
      ['Deploy', 'subtask'],
      ['Notes', 'subtask'],
    ]);
    expect(rows.slice(1).every((i) => i.parent_id && i.sprint_id === sprint.id)).toBe(true);
    expect(rows[0].sprint_id).toBe(sprint.id);
    const d = (await bob.client.get(`/api/issues/${rows[0].key}`)).body.issue;
    expect(d).toMatchObject({ description: 'Steps', labels: ['release'] });
    expect(d.children).toHaveLength(3);
  });

  it('works in slices when the query budget runs low', async () => {
    for (let n = 0; n < 3; n++) await makeRule(bob.client, { name: `r${n}`, startDate: '2026-11-17' }); // 3 dates each
    ctx.env.JOBS_MAX_QUERIES = 30;
    ctx.env.JOBS_BATCH = 2;
    const statuses = [];
    for (let i = 0; i < 20; i++) {
      const r = await run();
      statuses.push(r.status);
      if (r.status === 'done') break;
    }
    expect(statuses[0]).toBe('partial');
    expect(statuses.at(-1)).toBe('done');
    expect(await issues()).toHaveLength(9);
    const job = await ctx.db.get(`SELECT result FROM jobs WHERE name = 'recurring'`);
    expect(JSON.parse(job.result)).toMatchObject({ created: 9, summary: '9 issues created' });
  });

  it('runs on its own once its hour has passed', async () => {
    await makeRule(bob.client, { startDate: THU });
    clockMs = at(THU, 5);
    await ctx.db.run(`UPDATE jobs SET enabled = 0 WHERE name <> 'recurring'`);
    expect((await runDueJobs({ env: ctx.env, req: { url: 'https://tracker.example.com/api/x' } })).ran).toBe(null);
    clockMs = at(THU, 6.5);
    expect(await runDueJobs({ env: ctx.env, req: { url: 'https://tracker.example.com/api/x' } })).toMatchObject({
      ran: 'recurring',
      status: 'done',
      result: { created: 1 },
    });
  });
});

describe('announcing recurring issues', () => {
  it('sends the issue.created webhook and the assignee email like a normal create; sub-tasks stay silent', async () => {
    const calls = [];
    const fetch = async (url, init = {}) => {
      calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    resetJobThrottle();
    clockMs = at(THU, 7);
    ctx = await withAdmin({
      now: () => clockMs,
      fetch,
      PUBLIC_URL: 'https://tracker.example.com',
      POSTMARK_SERVER_TOKEN: 'pm-test-token',
      EMAIL_FROM: 'Tracker <tracker@example.com>',
      JOBS_MAX_QUERIES: 500,
    });
    bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
    carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
    await bob.client.post('/api/projects', { key: 'web', name: 'Website' });
    expect(
      (await bob.client.post('/api/projects/WEB/webhooks', { url: 'https://hooks.example.com/tracker', events: ['issue.created'] })).status,
    ).toBe(201);
    await makeRule(bob.client, { assigneeId: carol.id, subtasks: ['Step one'], type: 'task', startDate: THU });
    calls.length = 0;

    expect(await runAll()).toMatchObject({ status: 'done', result: { created: 1 } });
    expect((await issues()).map((i) => i.key)).toEqual(['WEB-1', 'WEB-2']); // the issue and its sub-task
    const hooks = calls.filter((c) => c.url.startsWith('https://hooks.example.com'));
    expect(hooks.map((h) => h.body.event)).toEqual(['issue.created']); // the sub-task is not announced
    expect(JSON.stringify(hooks[0].body)).toContain('WEB-1');
    const mail = calls.filter((c) => c.url.includes('postmark'));
    expect(mail.map((m) => m.body.To)).toEqual(['carol@example.com']); // assigned to Carol by the rule (made by Bob)
    expect(mail[0].body.Subject).toContain('WEB-1');

    // a second run creates nothing and announces nothing
    calls.length = 0;
    expect(await runAll()).toMatchObject({ result: { created: 0 } });
    expect(calls).toEqual([]);
  });
});
