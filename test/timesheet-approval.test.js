// Weekly timesheet submission and approval (server/routes/timeTracking.js, server/lib/timeTracking.js).
import { describe, it, expect } from 'vitest';
import { withAdmin, addUser } from './helpers.js';
import { LOCKED_MESSAGE } from '../server/lib/timeTracking.js';
import { mondayOf, validDate } from '../server/lib/time.js';

const WEEK = '2026-11-09'; // a Monday
const NEXT = '2026-11-16';

/** Lea leads WEB, Pat leads OPS (private); Bob logs time on WEB, Cat on OPS; Dan is a plain member. */
async function setup() {
  const ctx = await withAdmin();
  const lea = await addUser(ctx, { email: 'lea@example.com', name: 'Lea Lead' });
  const pat = await addUser(ctx, { email: 'pat@example.com', name: 'Pat Lead' });
  const bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  const cat = await addUser(ctx, { email: 'cat@example.com', name: 'Cat' });
  const dan = await addUser(ctx, { email: 'dan@example.com', name: 'Dan' });
  await lea.client.post('/api/projects', { key: 'WEB', name: 'Website' });
  await pat.client.post('/api/projects', { key: 'OPS', name: 'Operations', visibility: 'private' });
  await pat.client.put(`/api/projects/OPS/members/${cat.id}`, { role: 'member' });
  await pat.client.put(`/api/projects/OPS/members/${bob.id}`, { role: 'member' });
  const web = (await lea.client.post('/api/issues', { projectKey: 'WEB', title: 'Build' })).body.issue.key;
  const ops = (await pat.client.post('/api/issues', { projectKey: 'OPS', title: 'Run' })).body.issue.key;
  const log = (who, key, hours, workDate, extra = {}) => who.client.post(`/api/issues/${key}/worklogs`, { hours, workDate, ...extra });
  const sheet = async (who, week = WEEK) =>
    (await who.client.get(`/api/timesheet?from=${week}&to=${new Date(Date.parse(week) + 6 * 864e5).toISOString().slice(0, 10)}`)).body;
  const submit = (who, week = WEEK) => who.client.post('/api/timesheet/weeks', { week });
  const waiting = async (who) => (await who.client.get('/api/timesheet/approvals')).body.weeks;
  return { ctx, lea, pat, bob, cat, dan, web, ops, log, sheet, submit, waiting };
}

describe('week helpers', () => {
  it('weeks start on Monday', () => {
    expect(mondayOf('2026-11-09')).toBe('2026-11-09');
    expect(mondayOf('2026-11-15')).toBe('2026-11-09'); // Sunday belongs to the week before
    expect(mondayOf('2026-11-16')).toBe('2026-11-16');
    expect(mondayOf('2027-01-01')).toBe('2026-12-28');
    expect(validDate('2026-02-30')).toBe(false);
    expect(validDate('2026-02-28')).toBe(true);
  });
});

describe('timesheet submission', () => {
  it('submits a week, shows it as submitted and lets the person withdraw it', async () => {
    const { bob, web, log, sheet, submit } = await setup();
    expect((await log(bob, web, 3, '2026-11-10')).status).toBe(201);
    let s = await sheet(bob);
    expect(s.submission).toBeNull();
    expect(s.canSubmit).toBe(true);
    const r = await submit(bob, '2026-11-12'); // any day of the week
    expect(r.status).toBe(201);
    expect(r.body.week).toMatchObject({ weekStart: WEEK, weekEnd: '2026-11-15', status: 'submitted', locked: false, decidedBy: null });
    s = await sheet(bob);
    expect(s.submission).toMatchObject({ id: r.body.week.id, status: 'submitted' });
    expect((await submit(bob)).status).toBe(400); // already submitted
    expect((await sheet(bob, NEXT)).submission).toBeNull();
    // a submitted week is not locked yet
    expect((await log(bob, web, 1, '2026-11-11')).status).toBe(201);
    // withdraw
    expect((await bob.client.del(`/api/timesheet/weeks/${r.body.week.id}`)).status).toBe(200);
    expect((await sheet(bob)).submission).toBeNull();
    expect((await bob.client.del(`/api/timesheet/weeks/${r.body.week.id}`)).status).toBe(404);
    expect((await submit(bob)).status).toBe(201);
  });

  it('validates the week and refuses guests', async () => {
    const { ctx, bob } = await setup();
    expect((await bob.client.post('/api/timesheet/weeks', {})).status).toBe(400);
    expect((await bob.client.post('/api/timesheet/weeks', { week: '2026-13-01' })).status).toBe(400);
    const guest = await addUser(ctx, { email: 'gil@example.com', name: 'Gil Guest', role: 'guest' });
    expect((await guest.client.post('/api/timesheet/weeks', { week: WEEK })).status).toBe(403);
    expect((await guest.client.get('/api/timesheet/approvals')).body.weeks).toEqual([]);
  });

  it("nobody can withdraw or see another person's week by id", async () => {
    const { bob, dan, web, log, submit } = await setup();
    await log(bob, web, 2, '2026-11-10');
    const id = (await submit(bob)).body.week.id;
    expect((await dan.client.del(`/api/timesheet/weeks/${id}`)).status).toBe(404);
    expect((await dan.client.post(`/api/timesheet/weeks/${id}/approve`, {})).status).toBe(404);
    expect((await dan.client.post(`/api/timesheet/weeks/${id}/reject`, { comment: 'no' })).status).toBe(404);
  });
});

describe('approvers', () => {
  it('admins see every submitted week; a lead sees the weeks with work on their projects', async () => {
    const { ctx, lea, pat, bob, cat, dan, web, ops, log, submit, waiting } = await setup();
    await log(bob, web, 3, '2026-11-10');
    await log(bob, web, 2, '2026-11-11');
    await log(bob, ops, 1.5, '2026-11-12');
    await log(bob, web, 4, '2026-11-17'); // next week: not part of it
    await log(cat, ops, 5, '2026-11-13');
    await submit(bob);
    await submit(cat);

    const forAdmin = await waiting({ client: ctx.admin });
    expect(forAdmin.map((w) => w.user.name).sort()).toEqual(['Bob', 'Cat']);
    const bobWeek = forAdmin.find((w) => w.user.name === 'Bob');
    expect(bobWeek).toMatchObject({ weekStart: WEEK, status: 'submitted', total: 6.5 });
    expect(bobWeek.projects).toEqual([
      { key: 'WEB', name: 'Website', hours: 5 },
      { key: 'OPS', name: 'Operations', hours: 1.5 },
    ]);

    // Lea leads WEB: Bob's week only, the whole week, with the private project she cannot see left unnamed
    const forLea = await waiting(lea);
    expect(forLea).toHaveLength(1);
    expect(forLea[0].user.name).toBe('Bob');
    expect(forLea[0].total).toBe(6.5);
    expect(forLea[0].projects).toEqual([
      { key: 'WEB', name: 'Website', hours: 5 },
      { key: null, name: 'Other projects', hours: 1.5 },
    ]);
    // Pat leads OPS: both logged time there
    expect((await waiting(pat)).map((w) => w.user.name).sort()).toEqual(['Bob', 'Cat']);
    // plain members and the submitter see nothing to approve
    expect(await waiting(dan)).toEqual([]);
    expect(await waiting(bob)).toEqual([]);

    // Lea cannot decide Cat's week (no work on her project)
    const catWeek = forAdmin.find((w) => w.user.name === 'Cat');
    expect((await lea.client.post(`/api/timesheet/weeks/${catWeek.id}/approve`, {})).status).toBe(404);
    // a submitter cannot approve their own week
    expect((await bob.client.post(`/api/timesheet/weeks/${bobWeek.id}/approve`, {})).status).toBe(403);
    // Lea approves Bob's
    const ok = await lea.client.post(`/api/timesheet/weeks/${bobWeek.id}/approve`, { comment: 'Thanks' });
    expect(ok.status).toBe(200);
    expect(ok.body.week).toMatchObject({
      status: 'approved',
      locked: true,
      comment: 'Thanks',
      decidedBy: { id: lea.id, name: 'Lea Lead' },
    });
    expect(await waiting(lea)).toEqual([]);
    expect((await waiting(pat)).map((w) => w.user.name)).toEqual(['Cat']);
    expect((await lea.client.post(`/api/timesheet/weeks/${bobWeek.id}/approve`, {})).status).toBe(400); // already approved
  });

  it('a lead who submits their own week needs someone else; an admin can approve their own', async () => {
    const { ctx, lea, web, log, submit, waiting } = await setup();
    await log(lea, web, 2, '2026-11-10');
    const id = (await submit(lea)).body.week.id;
    expect(await waiting(lea)).toEqual([]);
    expect((await lea.client.post(`/api/timesheet/weeks/${id}/approve`, {})).status).toBe(403);
    await log({ client: ctx.admin }, web, 1, '2026-11-10');
    const mine = (await submit({ client: ctx.admin })).body.week.id;
    expect((await waiting({ client: ctx.admin })).map((w) => w.id).sort()).toEqual([id, mine].sort());
    expect((await ctx.admin.post(`/api/timesheet/weeks/${mine}/approve`, {})).status).toBe(200);
    const n = await ctx.db.get(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM notifications WHERE type LIKE 'timesheet_%'`);
    expect(n.n).toBe(0); // no notice to yourself
  });
});

describe('approve, reject and the lock', () => {
  it('locks an approved week for everyone but admins', async () => {
    const { ctx, lea, bob, web, log, sheet, submit } = await setup();
    await log(bob, web, 3, '2026-11-10');
    await log(bob, web, 2, '2026-11-18'); // the week after
    const logId = (await sheet(bob)).entries[0].id;
    const id = (await submit(bob)).body.week.id;
    expect((await lea.client.post(`/api/timesheet/weeks/${id}/approve`, {})).status).toBe(200);
    expect((await sheet(bob)).submission).toMatchObject({ status: 'approved', locked: true });

    // create, edit, delete in the approved week: refused with a plain message
    const add = await log(bob, web, 1, '2026-11-15');
    expect(add.status).toBe(400);
    expect(add.body.error).toBe(LOCKED_MESSAGE);
    expect((await bob.client.patch(`/api/worklogs/${logId}`, { billable: false })).status).toBe(400);
    expect((await bob.client.post('/api/worklogs/billable', { ids: [logId], billable: false })).status).toBe(400);
    expect((await bob.client.del(`/api/worklogs/${logId}`)).status).toBe(400);
    // the project lead (a project admin) is held to it as well
    expect((await lea.client.del(`/api/worklogs/${logId}`)).status).toBe(400);
    expect((await lea.client.patch(`/api/worklogs/${logId}`, { billable: false })).status).toBe(400);
    expect((await sheet(bob)).total).toBe(3);
    // other weeks, and other people in the same week, are not locked
    expect((await log(bob, web, 1, '2026-11-08')).status).toBe(201);
    expect((await log(bob, web, 1, '2026-11-16')).status).toBe(201);
    expect((await log(lea, web, 1, '2026-11-10')).status).toBe(201);
    // a timer cannot log into the locked week either
    await bob.client.post('/api/me/timer/start', { issueKey: web });
    expect((await bob.client.post('/api/me/timer/stop', { workDate: '2026-11-12' })).status).toBe(400);
    expect((await bob.client.get('/api/me/timer')).body.timer).not.toBeNull();
    await bob.client.del('/api/me/timer');

    // admins override
    expect((await ctx.admin.patch(`/api/worklogs/${logId}`, { billable: false })).status).toBe(200);
    expect((await ctx.admin.del(`/api/worklogs/${logId}`)).status).toBe(200);
    expect((await sheet(bob)).total).toBe(0);
    // an admin's own approved week stays editable for them
    await log({ client: ctx.admin }, web, 1, '2026-11-10');
    const mine = (await submit({ client: ctx.admin })).body.week.id;
    await ctx.admin.post(`/api/timesheet/weeks/${mine}/approve`, {});
    expect((await log({ client: ctx.admin }, web, 1, '2026-11-11')).status).toBe(201);
  });

  it('a rejected week is editable again and can be resubmitted', async () => {
    const { lea, bob, web, log, sheet, submit, waiting } = await setup();
    await log(bob, web, 3, '2026-11-10');
    const id = (await submit(bob)).body.week.id;
    expect((await lea.client.post(`/api/timesheet/weeks/${id}/reject`, {})).status).toBe(400); // a comment is required
    const r = await lea.client.post(`/api/timesheet/weeks/${id}/reject`, { comment: 'Tuesday is missing' });
    expect(r.status).toBe(200);
    expect(r.body.week).toMatchObject({ status: 'rejected', locked: false, comment: 'Tuesday is missing' });
    expect((await sheet(bob)).submission).toMatchObject({
      status: 'rejected',
      comment: 'Tuesday is missing',
      decidedBy: { name: 'Lea Lead' },
    });
    expect(await waiting(lea)).toEqual([]);
    expect((await lea.client.post(`/api/timesheet/weeks/${id}/approve`, {})).status).toBe(400); // not waiting any more
    expect((await log(bob, web, 4, '2026-11-11')).status).toBe(201);
    const again = await submit(bob);
    expect(again.status).toBe(200);
    expect(again.body.week).toMatchObject({ id, status: 'submitted', comment: null, decidedBy: null, decidedAt: null });
    expect((await waiting(lea))[0]).toMatchObject({ id, total: 7 });
    expect((await lea.client.post(`/api/timesheet/weeks/${id}/approve`, {})).status).toBe(200);
    expect((await submit(bob)).status).toBe(400); // approved
    expect((await bob.client.del(`/api/timesheet/weeks/${id}`)).status).toBe(400);
  });

  it('an admin can reopen an approved week by rejecting it; a lead cannot', async () => {
    const { ctx, lea, bob, web, log, submit } = await setup();
    await log(bob, web, 3, '2026-11-10');
    const id = (await submit(bob)).body.week.id;
    await lea.client.post(`/api/timesheet/weeks/${id}/approve`, {});
    expect((await lea.client.post(`/api/timesheet/weeks/${id}/reject`, { comment: 'Changed my mind' })).status).toBe(400);
    expect((await ctx.admin.post(`/api/timesheet/weeks/${id}/reject`, { comment: 'Wrong project' })).status).toBe(200);
    expect((await log(bob, web, 1, '2026-11-11')).status).toBe(201);
  });

  it('notifies the submitter and writes the audit log', async () => {
    const { ctx, lea, bob, web, log, submit } = await setup();
    await log(bob, web, 3, '2026-11-10');
    const id = (await submit(bob)).body.week.id;
    await lea.client.post(`/api/timesheet/weeks/${id}/reject`, { comment: 'Add Friday' });
    let notes = (await bob.client.get('/api/notifications')).body.notifications;
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      type: 'timesheet_rejected',
      message: 'Lea Lead rejected your timesheet for the week of 2026-11-09: Add Friday',
      link: '/timesheet?week=2026-11-09',
      read: false,
      actor: { name: 'Lea Lead' },
    });
    expect((await bob.client.get('/api/me')).body.unreadNotifications).toBe(1);
    await submit(bob);
    await ctx.admin.post(`/api/timesheet/weeks/${id}/approve`, {});
    notes = (await bob.client.get('/api/notifications')).body.notifications;
    expect(notes.map((n) => n.type).sort()).toEqual(['timesheet_approved', 'timesheet_rejected']);
    expect(notes.find((n) => n.type === 'timesheet_approved').message).toBe('Ada Admin approved your timesheet for the week of 2026-11-09');
    expect((await lea.client.get('/api/notifications')).body.notifications.filter((n) => n.type.startsWith('timesheet_'))).toEqual([]);

    const audit = await ctx.db.all(
      `SELECT actor_id, action, target_type, target_id, details FROM audit_log WHERE action LIKE 'timesheet.%' ORDER BY created_at, action`,
    );
    expect(audit.map((a) => a.action).sort()).toEqual([
      'timesheet.approved',
      'timesheet.rejected',
      'timesheet.submitted',
      'timesheet.submitted',
    ]);
    expect(audit.every((a) => a.target_type === 'timesheet_week' && a.target_id === id)).toBe(true);
    const rej = audit.find((a) => a.action === 'timesheet.rejected');
    expect(rej.actor_id).toBe(lea.id);
    expect(JSON.parse(rej.details)).toEqual({ userId: bob.id, week: WEEK, comment: 'Add Friday' });
  });

  it("admins see the submission on another person's timesheet", async () => {
    const { ctx, bob, web, log, submit } = await setup();
    await log(bob, web, 3, '2026-11-10');
    const id = (await submit(bob)).body.week.id;
    const s = (await ctx.admin.get(`/api/timesheet?from=${WEEK}&to=2026-11-15&user=${bob.id}`)).body;
    expect(s.submission).toMatchObject({ id, status: 'submitted' });
    expect(s.canSubmit).toBe(false);
    const team = (await ctx.admin.get(`/api/timesheet?from=${WEEK}&to=2026-11-15&user=team`)).body;
    expect(team.submission).toBeNull();
    const partial = (await bob.client.get(`/api/timesheet?from=2026-11-10&to=2026-11-15`)).body; // not a Monday to Sunday week
    expect(partial.submission).toBeNull();
    expect(partial.canSubmit).toBe(false);
  });
});
