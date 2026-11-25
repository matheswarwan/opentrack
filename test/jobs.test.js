import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser, client } from './helpers.js';
import { JOBS, claimRun, runDueJobs, periodStart, resetJobThrottle } from '../server/lib/jobs.js';
import { dueMessage } from '../server/lib/jobs/reminders.js';
import { localParts, localMidnight } from '../server/lib/time.js';

const SLACK_TOKEN = 'xoxb-1111-2222-abcdefghijkl';
const EMAIL_ENV = { POSTMARK_SERVER_TOKEN: 'pm-test-token', EMAIL_FROM: 'Tracker <tracker@example.com>' };
const SECRET = 'jobs-secret-0123456789abcdef';

// Local times in Vancouver (the default timeZone), worked out with the tz data in use (BC's offset changed in 2026).
const at = (date, h) => localMidnight(date, 'America/Vancouver') + h * 3600e3;
// Thursday 2026-11-19 08:30: the weekly digest (Mondays) is out of its catch-up window.
const THU_0830 = at('2026-11-19', 8.5);
const THU_0730 = at('2026-11-19', 7.5);
const MON_0830 = at('2026-11-16', 8.5);

/** One fake for both Slack and Postmark: records calls. */
function fakeServices() {
  const slack = [];
  const mail = [];
  async function fetch(url, init = {}) {
    if (url.startsWith('https://api.postmarkapp.com/')) {
      mail.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ErrorCode: 0, Message: 'OK' }), { headers: { 'content-type': 'application/json' } });
    }
    const u = new URL(url);
    const method = u.pathname.replace('/api/', '');
    const params = init.body ? JSON.parse(init.body) : Object.fromEntries(u.searchParams);
    slack.push({ method, params });
    const answers = {
      'auth.test': { ok: true, team: 'Acme', team_id: 'T1', user: 'tracker', user_id: 'UBOT' },
      'users.lookupByEmail': { ok: true, user: { id: `U_${params.email}` } },
      'conversations.open': { ok: true, channel: { id: `D_${params.users}` } },
      'chat.postMessage': { ok: true, ts: '1.2' },
    };
    return new Response(JSON.stringify(answers[method] || { ok: false, error: 'unknown_method' }), {
      headers: { 'content-type': 'application/json' },
    });
  }
  return {
    fetch,
    slack,
    mail,
    dms: (email) => slack.filter((s) => s.method === 'chat.postMessage' && s.params.channel === `D_U_${email}`),
    mailTo: (email) => mail.filter((m) => m.To === email),
  };
}

let ctx, svc, bob, carol, clockMs, queue;
const run = (opts) => runDueJobs({ env: ctx.env, req: { url: 'https://tracker.example.com/api/x' } }, opts);
const day = (base, n) => new Date(Date.parse(`${base}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const notes = (userId, type) => ctx.db.all('SELECT * FROM notifications WHERE user_id = ? AND type = ?', [userId, type]);

async function setup(extra = {}) {
  svc = fakeServices();
  queue = [];
  clockMs = THU_0830;
  resetJobThrottle();
  ctx = await withAdmin({
    fetch: svc.fetch,
    slackQueue: queue,
    jobsQueue: queue,
    now: () => clockMs,
    PUBLIC_URL: 'https://tracker.example.com',
    JOBS_SECRET: SECRET,
    ...EMAIL_ENV,
    ...extra,
  });
  // The maintenance jobs (trash_purge, backup, recurring; tested in test/trash.test.js, test/backup.test.js and
  // test/recurring.test.js) would also be due at 08:30; these tests are about the people-facing jobs.
  await ctx.db.run(`UPDATE jobs SET enabled = 0 WHERE name IN ('trash_purge', 'backup', 'recurring')`);
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
  await bob.client.post('/api/projects', { key: 'web', name: 'Website' });
  expect((await ctx.admin.put('/api/admin/slack', { token: SLACK_TOKEN })).status).toBe(200);
}
async function flush() {
  while (queue.length) await Promise.all(queue.splice(0));
}
const create = (c, data, key = 'WEB') => c.post('/api/issues', { projectKey: key, ...data });
async function clearDeliveries() {
  await flush();
  svc.slack.length = 0;
  svc.mail.length = 0;
}

describe('time zone helpers', () => {
  it('reads the local date, hour and weekday', () => {
    expect(localParts(THU_0830, 'America/Vancouver')).toMatchObject({ date: '2026-11-19', hour: 8, weekday: 4 });
    const t = Date.parse('2026-11-19T16:30:00Z');
    expect(localParts(t, 'Asia/Tokyo')).toMatchObject({ date: '2026-11-20', hour: 1, weekday: 5 });
    expect(localParts(t, 'UTC')).toMatchObject({ date: '2026-11-19', hour: 16, weekday: 4 });
    expect(new Date(localMidnight('2026-11-19', 'Asia/Tokyo')).toISOString()).toBe('2026-11-18T15:00:00.000Z');
    expect(new Date(localMidnight('2026-07-01', 'Europe/London')).toISOString()).toBe('2026-06-30T23:00:00.000Z');
    expect(new Date(localMidnight('2026-12-01', 'Europe/London')).toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });

  it('works out the period of daily and weekly jobs', () => {
    const daily = { hour: 8, weekday: null };
    const weekly = { hour: 8, weekday: 1 };
    expect(periodStart(daily, { date: '2026-11-19', hour: 7, weekday: 4 })).toBe(null);
    expect(periodStart(daily, { date: '2026-11-19', hour: 8, weekday: 4 })).toBe('2026-11-19');
    expect(periodStart(weekly, { date: '2026-11-16', hour: 7, weekday: 1 })).toBe(null);
    expect(periodStart(weekly, { date: '2026-11-16', hour: 9, weekday: 1 })).toBe('2026-11-16');
    expect(periodStart(weekly, { date: '2026-11-17', hour: 1, weekday: 2 })).toBe('2026-11-16'); // catch-up
    expect(periodStart(weekly, { date: '2026-11-19', hour: 9, weekday: 4 })).toBe(null);
  });

  it('writes the one-line reminder', () => {
    const today = '2026-11-19';
    expect(
      dueMessage(
        [
          { key: 'BC-4', due_date: '2026-11-17' },
          { key: 'WEB-12', due_date: today },
          { key: 'WEB-15', due_date: '2026-11-20' },
        ],
        today,
      ),
    ).toBe('3 issues due soon: BC-4 (overdue 2 days), WEB-12 (today), WEB-15 (tomorrow)');
    expect(dueMessage([{ key: 'A-1', due_date: '2026-11-18' }], today)).toBe('1 issue due soon: A-1 (overdue 1 day)');
  });
});

describe('claiming and scheduling', () => {
  beforeEach(() => setup());

  it('claims a run atomically: the second claim for the same day fails', async () => {
    expect(await claimRun(ctx.db, 'due_reminders', '2026-11-19', THU_0830)).toBe(true);
    expect(await claimRun(ctx.db, 'due_reminders', '2026-11-19', THU_0830)).toBe(false);
    expect(await claimRun(ctx.db, 'due_reminders', '2026-11-20', THU_0830 + 864e5)).toBe(true);
    const both = await Promise.all([
      claimRun(ctx.db, 'due_reminders', '2026-11-21', THU_0830),
      claimRun(ctx.db, 'due_reminders', '2026-11-21', THU_0830),
    ]);
    expect(both.filter(Boolean)).toHaveLength(1);
  });

  it('runs once per local day, after the local hour of the timeZone setting', async () => {
    clockMs = THU_0730;
    expect((await run()).ran).toBe(null); // 07:30 in Vancouver
    clockMs = THU_0830;
    const r = await run();
    expect(r).toMatchObject({ ran: 'due_reminders', status: 'done' });
    expect((await run()).ran).toBe(null); // already ran today
    clockMs = THU_0830 + 864e5;
    expect((await run()).ran).toBe('due_reminders'); // next day

    // Tokyo: the same instant is 00:30 the next local day, so not due yet
    expect((await ctx.admin.patch('/api/admin/settings', { timeZone: 'Asia/Tokyo' })).status).toBe(200);
    clockMs = Date.parse('2026-11-21T15:30:00Z'); // 2026-11-22 00:30 Tokyo
    expect((await run()).ran).toBe(null);
    clockMs = Date.parse('2026-11-21T23:30:00Z'); // 08:30 Tokyo
    expect((await run()).ran).toBe('due_reminders');
    expect((await ctx.admin.patch('/api/admin/settings', { timeZone: 'Mars/Base' })).status).toBe(400);
  });

  it('respects the hour, day and on/off an admin sets', async () => {
    const p = await ctx.admin.patch('/api/admin/jobs/due_reminders', { hour: 9 });
    expect(p.status).toBe(200);
    expect(p.body.jobs.find((j) => j.name === 'due_reminders')).toMatchObject({
      hour: 9,
      next: { dueNow: false, date: '2026-11-19', hour: 9 },
    });
    expect((await run()).ran).toBe(null); // 08:30 < 09:00
    expect((await ctx.admin.patch('/api/admin/jobs/due_reminders', { weekday: 2 })).status).toBe(400);
    expect((await ctx.admin.patch('/api/admin/jobs/weekly_digest', { weekday: 4, hour: 8 })).status).toBe(200);
    expect((await ctx.admin.patch('/api/admin/jobs/weekly_digest', { enabled: false })).status).toBe(200);
    expect((await run()).ran).toBe(null);
    await ctx.admin.patch('/api/admin/jobs/weekly_digest', { enabled: true });
    expect((await run()).ran).toBe('weekly_digest');
  });

  it('runs from ordinary signed-in requests, at most once a minute', async () => {
    ctx.env.JOBS_AUTO = 'on';
    await create(bob.client, { title: 'Due today', assigneeId: carol.id, dueDate: '2026-11-19' });
    await flush();
    expect(await notes(carol.id, 'due')).toHaveLength(0); // heavier requests never start a job
    await bob.client.get('/api/me');
    await flush();
    expect(await notes(carol.id, 'due')).toHaveLength(1); // a light request does
    resetJobThrottle();
    clockMs = THU_0830 + 864e5;
    await carol.client.get('/api/me');
    await carol.client.get('/api/me'); // throttled
    await flush();
    expect(await notes(carol.id, 'due')).toHaveLength(2);
    const j = await ctx.admin.get('/api/admin/jobs');
    expect(j.body.jobs.find((x) => x.name === 'due_reminders')).toMatchObject({ lastRunOn: '2026-11-20', status: 'done' });
  });
});

describe('due-date reminders', () => {
  beforeEach(() => setup());

  it('sends one message per person per day with the issues due soon', async () => {
    const today = '2026-11-19';
    await create(bob.client, { title: 'Due today', assigneeId: carol.id, dueDate: today }); // WEB-1
    await create(bob.client, { title: 'Due tomorrow', assigneeId: carol.id, dueDate: day(today, 1) }); // WEB-2
    await create(bob.client, { title: 'Late', assigneeId: carol.id, dueDate: day(today, -2) }); // WEB-3
    await create(bob.client, { title: 'Later', assigneeId: carol.id, dueDate: day(today, 5) }); // WEB-4 (not yet)
    const done = await ctx.db.get(
      `SELECT s.id FROM statuses s JOIN projects p ON p.id = s.project_id WHERE p.key = 'WEB' AND s.category = 'done'`,
    );
    await create(bob.client, { title: 'Finished', assigneeId: carol.id, dueDate: today, statusId: done.id }); // WEB-5 (done)
    await create(carol.client, { title: 'Bob due', assigneeId: bob.id, dueDate: today }); // WEB-6
    await clearDeliveries();

    const r = await run();
    expect(r).toMatchObject({ ran: 'due_reminders', status: 'done' });
    expect(r.result).toMatchObject({ notified: 2, slack: 2, email: 2 });
    const [n] = await notes(carol.id, 'due');
    expect(n.message).toBe('3 issues due soon: WEB-3 (overdue 2 days), WEB-1 (today), WEB-2 (tomorrow)');
    expect(n.issue_id).toBe(null);
    expect(await notes(bob.id, 'due')).toHaveLength(1);

    const dm = svc.dms('carol@example.com');
    expect(dm).toHaveLength(1);
    expect(dm[0].params.blocks[0].text.text).toContain('<https://tracker.example.com/browse/WEB-3|WEB-3> Late (overdue 2 days)');
    expect(dm[0].params.blocks[0].text.text).toContain('/issues?assignee=me&category=todo,in_progress&dueBefore=2026-11-20');
    const [mail] = svc.mailTo('carol@example.com');
    expect(mail.Subject).toBe('3 issues due soon');
    expect(mail.TextBody).toContain('WEB-1 (today): Due today');
    expect(mail.TextBody).not.toContain('WEB-4');
    expect(mail.TextBody).not.toContain('WEB-5');

    // Run now again the same day: nobody gets a second message
    const again = await ctx.admin.post('/api/admin/jobs/run', { name: 'due_reminders' });
    expect(again.status).toBe(200);
    expect(again.body.ran).toBe('due_reminders');
    expect(await notes(carol.id, 'due')).toHaveLength(1);
    expect(svc.dms('carol@example.com')).toHaveLength(1);
    expect(svc.mailTo('carol@example.com')).toHaveLength(1);

    // the notification opens the filtered issue list (no issue key)
    const list = await carol.client.get('/api/notifications');
    expect(list.body.notifications.find((x) => x.type === 'due')).toMatchObject({ issueKey: null });
  });

  it('respects the Slack and email preferences', async () => {
    await create(bob.client, { title: 'Due today', assigneeId: carol.id, dueDate: '2026-11-19' });
    expect((await carol.client.get('/api/me/reminders')).body.prefs).toEqual({
      dueSlack: true,
      dueEmail: true,
      digestSlack: true,
      digestEmail: true,
    });
    const p = await carol.client.put('/api/me/reminders', { dueEmail: false });
    expect(p.body.prefs).toMatchObject({ dueSlack: true, dueEmail: false });
    expect((await carol.client.put('/api/me/reminders', { dueSlack: 'no' })).status).toBe(400);
    await clearDeliveries();
    await run();
    expect(await notes(carol.id, 'due')).toHaveLength(1); // in-app always
    expect(svc.mailTo('carol@example.com')).toHaveLength(0);
    expect(svc.dms('carol@example.com')).toHaveLength(1);

    clockMs += 864e5;
    await carol.client.put('/api/me/reminders', { dueSlack: false, dueEmail: true });
    await run();
    expect(svc.dms('carol@example.com')).toHaveLength(1);
    expect(svc.mailTo('carol@example.com')).toHaveLength(1);

    clockMs += 864e5;
    await carol.client.put('/api/me/slack', { dm: false }); // all personal Slack messages off
    await carol.client.put('/api/me/reminders', { dueSlack: true });
    await run();
    expect(svc.dms('carol@example.com')).toHaveLength(1);
    expect(await notes(carol.id, 'due')).toHaveLength(3);
  });

  it('every job is a run hook; the saved result keeps its shape', async () => {
    for (const [name, def] of Object.entries(JOBS)) expect(typeof def.run, name).toBe('function');
    await create(bob.client, { title: 'Due', assigneeId: carol.id, dueDate: '2026-11-19' });
    const r = await run({ force: 'due_reminders' });
    expect(r).toMatchObject({ ran: 'due_reminders', status: 'done', error: null });
    const row = await ctx.db.get(`SELECT status, cursor, result, error, finished_at FROM jobs WHERE name = 'due_reminders'`);
    expect(row).toMatchObject({ status: 'done', cursor: null, error: null });
    expect(row.finished_at).toBeTruthy();
    expect(row.result).toBe(JSON.stringify({ people: 3, notified: 1, slack: 1, email: 1, slices: 1 }));
    const t = await run({ force: 'trash_purge' });
    expect(t.status).toBe('done');
    const purge = await ctx.db.get(`SELECT cursor, result FROM jobs WHERE name = 'trash_purge'`);
    expect(purge.cursor).toBe(null);
    expect(Object.keys(JSON.parse(purge.result))).toEqual(['slices', 'purged', 'files', 'projects', 'summary']);
  });

  it('a job that fails part way is saved as an error with the place it reached', async () => {
    const ids = (await ctx.db.all(`SELECT id FROM users WHERE status = 'active' AND is_system = 0 ORDER BY id`)).map((u) => u.id);
    const last = ids[ids.length - 1];
    const db = ctx.env.db;
    ctx.env.db = {
      ...db,
      all: async (sql, params) => {
        if (sql.includes('ORDER BY i.due_date, p.key') && params.includes(last)) throw new Error('database went away');
        return db.all(sql, params);
      },
    };
    const log = console.error;
    console.error = () => {};
    const r = await run({ force: 'due_reminders' });
    console.error = log;
    ctx.env.db = db;
    expect(r).toMatchObject({ ran: 'due_reminders', status: 'error', error: 'database went away' });
    const row = await ctx.db.get(`SELECT status, cursor, result, error, finished_at FROM jobs WHERE name = 'due_reminders'`);
    expect(row).toMatchObject({ status: 'error', cursor: ids[ids.length - 2], error: 'database went away' });
    expect(row.finished_at).toBeTruthy();
    expect(JSON.parse(row.result)).toMatchObject({ people: ids.length - 1, slices: 1 });
  });

  it('works in batches and continues where the last slice stopped', async () => {
    const people = [carol];
    for (const n of ['dan', 'eve', 'fay', 'gus']) people.push(await addUser(ctx, { email: `${n}@example.com`, name: n }));
    for (const p of people) await create(bob.client, { title: `For ${p.id}`, assigneeId: p.id, dueDate: '2026-11-19' });
    await clearDeliveries();
    ctx.env.JOBS_MAX_QUERIES = 22;
    ctx.env.JOBS_BATCH = 2;
    const first = await run();
    expect(first.status).toBe('partial');
    const row = await ctx.db.get(`SELECT status, cursor FROM jobs WHERE name = 'due_reminders'`);
    expect(row.status).toBe('partial');
    expect(row.cursor).toBeTruthy();
    let slices = 1;
    for (let i = 0; i < 20; i++) {
      const r = await run();
      if (!r.ran) break;
      slices++;
      if (r.status === 'done') break;
    }
    expect(slices).toBeGreaterThan(2);
    const final = await ctx.db.get(`SELECT status, cursor, result FROM jobs WHERE name = 'due_reminders'`);
    expect(final.status).toBe('done');
    expect(final.cursor).toBe(null);
    expect(JSON.parse(final.result)).toMatchObject({ notified: 5, slices });
    for (const p of people) {
      expect(await notes(p.id, 'due')).toHaveLength(1);
      expect(
        svc.dms(p.id === carol.id ? 'carol@example.com' : (await ctx.db.get('SELECT email FROM users WHERE id = ?', [p.id])).email),
      ).toHaveLength(1);
    }
    expect((await run()).ran).toBe(null); // finished for today
  });

  it('skips Slack and email when they are not set up', async () => {
    await ctx.admin.del('/api/admin/slack');
    delete ctx.env.POSTMARK_SERVER_TOKEN;
    await create(bob.client, { title: 'Due today', assigneeId: carol.id, dueDate: '2026-11-19' });
    await clearDeliveries();
    const r = await run();
    expect(r.result).toMatchObject({ notified: 1, slack: 0, email: 0 });
    expect(svc.slack).toHaveLength(0);
    expect(svc.mail).toHaveLength(0);
  });
});

describe('weekly digest', () => {
  beforeEach(async () => {
    await setup();
    clockMs = MON_0830;
    await ctx.admin.patch('/api/admin/jobs/due_reminders', { enabled: false }); // Monday 08:30 would run it first
  });

  async function seed() {
    await create(bob.client, { title: 'Overdue work', assigneeId: carol.id, dueDate: '2026-11-13' }); // WEB-1
    await create(bob.client, { title: 'This week', assigneeId: carol.id, dueDate: '2026-11-18' }); // WEB-2
    await create(bob.client, { title: 'No date', assigneeId: carol.id }); // WEB-3
    await create(carol.client, { title: 'Watched by carol', description: 'x' }); // WEB-4, carol reporter = watcher
    await bob.client.patch('/api/issues/WEB-4', { priority: 'high' });
    await bob.client.post('/api/issues/WEB-4/comments', { body: `Ping @[Carol](user:${carol.id})` });
    // private project carol cannot see: the mention there must not show up
    await bob.client.post('/api/projects', { key: 'sec', name: 'Secret', visibility: 'private' });
    await create(bob.client, { title: 'Hidden', description: `See @[Carol](user:${carol.id})` }, 'SEC');
    await clearDeliveries();
  }

  it('shows the signed-in person their digest at /api/digest, without private projects', async () => {
    await seed();
    const r = await carol.client.get('/api/digest');
    expect(r.status).toBe(200);
    const d = r.body;
    expect(d.today).toBe('2026-11-16');
    expect(d.open.total).toBe(3);
    expect(d.open.byStatus).toEqual([expect.objectContaining({ count: 3 })]);
    expect(d.overdue.map((i) => i.key)).toEqual(['WEB-1']);
    expect(d.overdue[0].due).toBe('overdue 3 days');
    expect(d.dueThisWeek.map((i) => i.key)).toEqual(['WEB-2']);
    expect(d.watched.find((w) => w.key === 'WEB-4')).toMatchObject({ changes: 1, comments: 1 });
    expect(d.watched.find((w) => w.key === 'WEB-1')).toMatchObject({ changes: 1, comments: 0 }); // created by Bob this week
    expect(d.mentions.map((m) => m.key)).toEqual(['WEB-4']);
    expect(JSON.stringify(d)).not.toContain('SEC-');
    expect(JSON.stringify(d)).not.toContain('Hidden');
    // bob sees his own (his changes on WEB-4 do not count as news for him)
    const b = (await bob.client.get('/api/digest')).body;
    expect(b.watched.map((w) => w.key)).not.toContain('WEB-1');
  });

  it('sends the digest on Monday by email, Slack and in-app, once', async () => {
    await seed();
    const r = await run();
    expect(r).toMatchObject({ ran: 'weekly_digest', status: 'done' });
    const [n] = await notes(carol.id, 'digest');
    expect(n.message).toBe('Your weekly digest is ready');
    const [mail] = svc.mailTo('carol@example.com');
    expect(mail.Subject).toBe('Your weekly digest: 3 open issues, 1 overdue');
    expect(mail.TextBody).toContain('Overdue (1)');
    expect(mail.TextBody).toContain('WEB-4 Watched by carol: 1 change, 1 comment');
    expect(mail.TextBody).toContain('https://tracker.example.com/digest');
    expect(mail.TextBody).not.toContain('Hidden');
    const dm = svc.dms('carol@example.com');
    expect(dm).toHaveLength(1);
    expect(dm[0].params.blocks[0].text.text).toContain('*Mentions (1)*');
    expect(svc.mailTo('admin@example.com')).toHaveLength(0); // empty digest: nothing sent

    await carol.client.put('/api/me/reminders', { digestEmail: false });
    const again = await ctx.admin.post('/api/admin/jobs/run', { name: 'weekly_digest' });
    expect(again.body.ran).toBe('weekly_digest');
    expect(await notes(carol.id, 'digest')).toHaveLength(1);
    expect(svc.mailTo('carol@example.com')).toHaveLength(1);
  });

  it('respects the digest preferences', async () => {
    await seed();
    await carol.client.put('/api/me/reminders', { digestEmail: false, digestSlack: false });
    await run();
    expect(await notes(carol.id, 'digest')).toHaveLength(1);
    expect(svc.mailTo('carol@example.com')).toHaveLength(0);
    expect(svc.dms('carol@example.com')).toHaveLength(0);
  });
});

describe('/api/admin/jobs access', () => {
  beforeEach(() => setup());

  it('allows admins and the JOBS_SECRET, not members or other tokens', async () => {
    const a = await ctx.admin.get('/api/admin/jobs');
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ timeZone: 'America/Vancouver', localNow: '2026-11-19 08:30', secretConfigured: true });
    expect(a.body.jobs.map((j) => j.name)).toEqual([
      'due_reminders',
      'weekly_digest',
      'trash_purge',
      'backup',
      'github_backup',
      'recurring',
      'channel_ai',
    ]);
    expect(a.body.jobs[0].next).toMatchObject({ dueNow: true });

    expect((await bob.client.get('/api/admin/jobs')).status).toBe(403);
    expect((await bob.client.post('/api/admin/jobs/run', {})).status).toBe(403);
    const anon = client(ctx);
    expect((await anon.get('/api/admin/jobs')).status).toBe(401);
    expect((await anon.post('/api/admin/jobs/run', {}, { headers: { authorization: 'Bearer wrong-secret-0123456789' } })).status).toBe(401);
    // the secret works only on the jobs endpoints
    expect((await anon.get('/api/me', { headers: { authorization: `Bearer ${SECRET}` } })).status).toBe(401);
    expect(
      (await anon.patch('/api/admin/jobs/due_reminders', { hour: 3 }, { headers: { authorization: `Bearer ${SECRET}` } })).status,
    ).toBe(401);

    const s = await anon.get('/api/admin/jobs', { headers: { authorization: `Bearer ${SECRET}` } });
    expect(s.status).toBe(200);
    const r = await anon.post('/api/admin/jobs/run', {}, { headers: { authorization: `Bearer ${SECRET}` }, noCsrf: true });
    expect(r.status).toBe(200);
    expect(r.body.ran).toBe('due_reminders');
    expect(r.body.jobs.find((j) => j.name === 'due_reminders')).toMatchObject({ lastRunOn: '2026-11-19', status: 'done' });
    expect((await ctx.admin.post('/api/admin/jobs/run', { name: 'nope' })).status).toBe(400);
  });

  it('turns the secret off when it is short or missing', async () => {
    ctx.env.JOBS_SECRET = 'short';
    const anon = client(ctx);
    expect((await anon.get('/api/admin/jobs', { headers: { authorization: 'Bearer short' } })).status).toBe(401);
  });
});
