// Issue timer and weekly timesheet approval (server/lib/timeTracking.js).
//
//   GET    /api/me/timer                        the running timer, or null
//   POST   /api/me/timer/start                  { issueKey } start one; a timer running on another issue is stopped and logged first
//   POST   /api/me/timer/stop                   { note?, hours?, workDate?, billable? } log the elapsed time as a work log
//   DELETE /api/me/timer                        discard without logging
//   POST   /api/timesheet/weeks                 { week } submit your week (any date in it; weeks start on Monday)
//   DELETE /api/timesheet/weeks/:id             withdraw your submitted week
//   POST   /api/timesheet/weeks/:id/approve     { comment? } approvers
//   POST   /api/timesheet/weeks/:id/reject      { comment } approvers (admins can also reject an approved week to reopen it)
//   GET    /api/timesheet/approvals             submitted weeks waiting for you, with hours per project
//
// Approvers: workspace admins, and the lead of a project the person logged time on in that week.
import { body, fail, str, num, isoDate, ApiError } from '../lib/http.js';
import { uuid, now } from '../lib/crypto.js';
import { noticeStmts } from '../lib/notifications.js';
import { visibleProjectsSql } from '../lib/access.js';
import { requireNotGuest } from '../lib/session.js';
import { audit } from '../lib/audit.js';
import { avatarUrl } from '../lib/avatars.js';
import { clock, mondayOf, addDays, validDate, today } from '../lib/time.js';
import { loadIssue } from '../lib/issues/guards.js';
import { addWorklog } from '../lib/issues/write.js';
import { elapsed, TIMER_CONFIRM_HOURS, weekOut, WEEK_SELECT, canDecide } from '../lib/timeTracking.js';
import { placeholders, chunks } from '../db/sql.js';

const round2 = (n) => Math.round(Number(n) * 100) / 100;

function timerOut(row, nowMs) {
  const e = elapsed(row.started_at, nowMs);
  return {
    issueKey: row.key,
    title: row.title,
    type: row.type,
    startedAt: row.started_at,
    minutes: e.minutes,
    hours: e.hours,
    needsConfirm: e.hours > TIMER_CONFIRM_HOURS, // stopping asks for the hours
  };
}

const myTimer = (db, userId) =>
  db.get('SELECT t.started_at, i.key, i.title, i.type, i.deleted_at FROM timers t JOIN issues i ON i.id = t.issue_id WHERE t.user_id = ?', [
    userId,
  ]);

/** Log the timer as a work log and delete it (one batch). opts: note, hours (replaces the elapsed time), workDate, billable. */
async function logTimer(c, timer, opts = {}) {
  const me = c.get('user');
  const issue = await loadIssue(c, timer.key, 'edit'); // the same check as logging work by hand
  const nowMs = clock(c.env);
  const e = elapsed(timer.started_at, nowMs);
  if (opts.hours === undefined && e.hours > TIMER_CONFIRM_HOURS) {
    fail(409, `The timer on ${timer.key} ran for more than ${TIMER_CONFIRM_HOURS} hours. Confirm the hours to log.`, {
      code: 'confirm_hours',
      issueKey: timer.key,
      hours: e.hours,
    });
  }
  const hours = opts.hours === undefined ? e.hours : opts.hours;
  const workDate = opts.workDate || (await today(c));
  await addWorklog(c, issue, { hours, note: opts.note || null, date: workDate, billable: opts.billable !== false }, [
    { sql: 'DELETE FROM timers WHERE user_id = ?', params: [me.id] },
  ]);
  return { issueKey: timer.key, hours, minutes: e.minutes, workDate };
}

async function loadWeek(db, id) {
  const w = await db.get(`${WEEK_SELECT} WHERE tw.id = ?`, [id]);
  if (!w) fail(404, 'Timesheet week not found');
  return w;
}

function noticeStmt(week, actor, verb, comment, t) {
  if (week.user_id === actor.id) return [];
  return noticeStmts([
    {
      userId: week.user_id,
      type: `timesheet_${verb}`,
      actorId: actor.id,
      at: t,
      link: `/timesheet?week=${week.week_start}`,
      message: `${actor.name} ${verb} your timesheet for the week of ${week.week_start}${comment ? `: ${comment.slice(0, 300)}` : ''}`,
    },
  ]);
}

async function decide(c, verb) {
  const db = c.env.db;
  const me = c.get('user');
  const week = await loadWeek(db, c.req.param('id'));
  // 404, not 403: someone who is not an approver of this week should not learn it exists
  if (week.user_id !== me.id && !(await canDecide(db, me, week))) fail(404, 'Timesheet week not found');
  if (week.user_id === me.id && me.role !== 'admin') fail(403, 'You cannot approve or reject your own timesheet');
  const b = await body(c);
  const comment = str(b.comment, { max: 1000, name: 'Comment' }) || null;
  const reopen = verb === 'rejected' && week.status === 'approved' && me.role === 'admin';
  if (week.status !== 'submitted' && !reopen)
    fail(400, week.status === 'approved' ? 'This week is already approved' : 'This week is not waiting for approval');
  if (verb === 'rejected' && !comment) fail(400, 'Say why you are rejecting it');
  const t = now();
  await db.batch([
    {
      sql: 'UPDATE timesheet_weeks SET status = ?, decided_by = ?, decided_at = ?, comment = ? WHERE id = ?',
      params: [verb, me.id, t, comment, week.id],
    },
    ...noticeStmt(week, me, verb, comment, t),
    audit(me.id, `timesheet.${verb}`, 'timesheet_week', week.id, {
      userId: week.user_id,
      week: week.week_start,
      ...(comment ? { comment } : {}),
    }),
  ]);
  return c.json({ week: weekOut(await loadWeek(db, week.id)) });
}

export function registerTimeTracking(app) {
  // ---- timer ----
  app.get('/api/me/timer', async (c) => {
    const me = c.get('user');
    const v = visibleProjectsSql(me);
    const row = await c.env.db.get(
      `SELECT t.started_at, i.key, i.title, i.type FROM timers t JOIN issues i ON i.id = t.issue_id JOIN projects p ON p.id = i.project_id
        WHERE t.user_id = ? AND i.deleted_at IS NULL AND ${v.sql}`,
      [me.id, ...v.params],
    );
    const nowMs = clock(c.env);
    return c.json({ timer: row ? timerOut(row, nowMs) : null, now: new Date(nowMs).toISOString(), confirmAfterHours: TIMER_CONFIRM_HOURS });
  });

  app.post('/api/me/timer/start', async (c) => {
    const db = c.env.db;
    const me = c.get('user');
    const b = await body(c);
    const issue = await loadIssue(c, str(b.issueKey, { required: true, max: 40, name: 'Issue' }), 'edit'); // who may log work on it
    const nowMs = clock(c.env);
    const running = await myTimer(db, me.id);
    if (running && running.key === issue.row.key && !running.deleted_at) return c.json({ timer: timerOut(running, nowMs), logged: null });
    let logged = null;
    if (running) {
      try {
        logged = await logTimer(c, running);
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        // The issue is gone (Trash, or no longer visible): there is nothing to log it on, so the new timer replaces it.
        if (e.status !== 404) {
          fail(
            409,
            e.extra?.code === 'confirm_hours'
              ? `Your timer on ${running.key} ran for more than ${TIMER_CONFIRM_HOURS} hours. Stop it and confirm the hours, or discard it, before starting another.`
              : `Your timer on ${running.key} could not be logged (${e.message}). Stop or discard it before starting another.`,
            { code: 'timer_running', issueKey: running.key },
          );
        }
      }
    }
    const startedAt = new Date(nowMs).toISOString();
    await db.batch([
      { sql: 'DELETE FROM timers WHERE user_id = ?', params: [me.id] },
      { sql: 'INSERT INTO timers (user_id, issue_id, started_at) VALUES (?, ?, ?)', params: [me.id, issue.row.id, startedAt] },
    ]);
    return c.json(
      { timer: timerOut({ started_at: startedAt, key: issue.row.key, title: issue.row.title, type: issue.row.type }, nowMs), logged },
      201,
    );
  });

  app.post('/api/me/timer/stop', async (c) => {
    const me = c.get('user');
    const b = await body(c);
    const running = await myTimer(c.env.db, me.id);
    if (!running) fail(404, 'No timer is running');
    const hours = num(b.hours, { name: 'Hours', min: 0.01, max: 24 });
    const logged = await logTimer(c, running, {
      note: str(b.note, { max: 2000, name: 'Note' }),
      hours: hours === null ? undefined : hours,
      workDate: isoDate(b.workDate, 'Date') || undefined,
      billable: b.billable !== false,
    });
    return c.json({ ok: true, logged });
  });

  app.delete('/api/me/timer', async (c) => {
    const r = await c.env.db.run('DELETE FROM timers WHERE user_id = ?', [c.get('user').id]);
    return c.json({ ok: true, discarded: Boolean(r.changes) });
  });

  // ---- weekly submission ----
  app.post('/api/timesheet/weeks', async (c) => {
    requireNotGuest(c, 'submit timesheets');
    const db = c.env.db;
    const me = c.get('user');
    const b = await body(c);
    if (!validDate(b.week)) fail(400, 'Week must be a date, YYYY-MM-DD');
    const start = mondayOf(b.week);
    const old = await db.get('SELECT id, status FROM timesheet_weeks WHERE user_id = ? AND week_start = ?', [me.id, start]);
    if (old?.status === 'submitted') fail(400, 'This week is already submitted');
    if (old?.status === 'approved') fail(400, 'This week is already approved');
    const id = old?.id || uuid();
    const t = now();
    await db.batch([
      old
        ? {
            sql: `UPDATE timesheet_weeks SET status = 'submitted', submitted_at = ?, decided_by = NULL, decided_at = NULL, comment = NULL WHERE id = ?`,
            params: [t, id],
          }
        : {
            sql: `INSERT INTO timesheet_weeks (id, user_id, week_start, week_end, status, submitted_at) VALUES (?, ?, ?, ?, 'submitted', ?)`,
            params: [id, me.id, start, addDays(start, 6), t],
          },
      audit(me.id, 'timesheet.submitted', 'timesheet_week', id, { userId: me.id, week: start, ...(old ? { resubmitted: true } : {}) }),
    ]);
    return c.json({ week: weekOut(await loadWeek(db, id)) }, old ? 200 : 201);
  });

  app.delete('/api/timesheet/weeks/:id', async (c) => {
    const db = c.env.db;
    const me = c.get('user');
    const week = await db.get('SELECT id, user_id, week_start, status FROM timesheet_weeks WHERE id = ? AND user_id = ?', [
      c.req.param('id'),
      me.id,
    ]);
    if (!week) fail(404, 'Timesheet week not found');
    if (week.status !== 'submitted') fail(400, week.status === 'approved' ? 'This week is already approved' : 'This week is not submitted');
    await db.batch([
      { sql: 'DELETE FROM timesheet_weeks WHERE id = ?', params: [week.id] },
      audit(me.id, 'timesheet.withdrawn', 'timesheet_week', week.id, { userId: me.id, week: week.week_start }),
    ]);
    return c.json({ ok: true });
  });

  app.post('/api/timesheet/weeks/:id/approve', (c) => decide(c, 'approved'));
  app.post('/api/timesheet/weeks/:id/reject', (c) => decide(c, 'rejected'));

  app.get('/api/timesheet/approvals', async (c) => {
    const db = c.env.db;
    const me = c.get('user');
    if (me.role === 'guest') return c.json({ weeks: [] });
    const admin = me.role === 'admin';
    const weeks = await db.all(
      `SELECT tw.*, u.name AS user_name, u.avatar_color, u.avatar_version FROM timesheet_weeks tw JOIN users u ON u.id = tw.user_id
        WHERE tw.status = 'submitted'${
          admin
            ? ''
            : ` AND tw.user_id <> ? AND EXISTS (
          SELECT 1 FROM worklogs w JOIN issues i ON i.id = w.issue_id JOIN projects p ON p.id = i.project_id
           WHERE w.user_id = tw.user_id AND w.work_date >= tw.week_start AND w.work_date <= tw.week_end
             AND i.deleted_at IS NULL AND p.deleted_at IS NULL AND p.lead_id = ?)`
        }
        ORDER BY tw.week_start, tw.submitted_at LIMIT 200`,
      admin ? [] : [me.id, me.id],
    );
    // Hours per person, day and project in one query per 80 people; projects the approver cannot see are shown without a name.
    const v = visibleProjectsSql(me);
    const users = [...new Set(weeks.map((w) => w.user_id))];
    const from = weeks.reduce((m, w) => (w.week_start < m ? w.week_start : m), '9999-12-31');
    const to = weeks.reduce((m, w) => (w.week_end > m ? w.week_end : m), '');
    const logs = [];
    for (const part of chunks(users)) {
      logs.push(
        ...(await db.all(
          `SELECT w.user_id, w.work_date, p.id AS project_id, p.key, p.name, SUM(w.hours) AS hours, MAX(CASE WHEN ${v.sql} THEN 1 ELSE 0 END) AS visible
           FROM worklogs w JOIN issues i ON i.id = w.issue_id JOIN projects p ON p.id = i.project_id
          WHERE i.deleted_at IS NULL AND p.deleted_at IS NULL AND w.user_id IN (${placeholders(part.length)}) AND w.work_date >= ? AND w.work_date <= ?
          GROUP BY w.user_id, w.work_date, p.id, p.key, p.name`,
          [...v.params, ...part, from, to],
        )),
      );
    }
    const out = weeks.map((w) => {
      const projects = new Map();
      let total = 0;
      for (const l of logs) {
        if (l.user_id !== w.user_id || l.work_date < w.week_start || l.work_date > w.week_end) continue;
        const seen = Number(l.visible) === 1;
        const k = seen ? l.project_id : 'other';
        if (!projects.has(k)) projects.set(k, { key: seen ? l.key : null, name: seen ? l.name : 'Other projects', hours: 0 });
        projects.get(k).hours += Number(l.hours);
        total += Number(l.hours);
      }
      return {
        ...weekOut(w),
        user: { id: w.user_id, name: w.user_name, avatarColor: w.avatar_color, avatarUrl: avatarUrl(w.user_id, w.avatar_version) },
        total: round2(total),
        projects: [...projects.values()]
          .map((p) => ({ key: p.key, name: p.name, hours: round2(p.hours) }))
          .sort((a, b) => b.hours - a.hours),
      };
    });
    return c.json({ weeks: out });
  });
}
