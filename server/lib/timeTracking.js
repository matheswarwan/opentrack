// Time tracking helpers: the issue timer and weekly timesheet approval (routes: server/routes/timeTracking.js).
//
// Weeks start on Monday, as the Timesheet page groups them. A week a person submitted has a timesheet_weeks row
// (submitted, approved or rejected). An approved week is locked: work logs dated in it cannot be added, changed or
// deleted, except by workspace admins.
import { fail } from './http.js';
import { mondayOf } from './time.js';
import { placeholders } from '../db/sql.js';

export const LOCKED_MESSAGE = 'The timesheet for this week is approved and locked. Ask a workspace admin to change it.';

/**
 * Refuse (400) a change to work logs dated in an approved week. entries: [{ userId, date }] (the person the work
 * log belongs to and its work date). Workspace admins may always change them. One query.
 */
export async function assertWeeksOpen(db, actor, entries) {
  if (actor.role === 'admin') return;
  const list = entries.filter((e) => e.userId && e.date);
  if (!list.length) return;
  const users = [...new Set(list.map((e) => e.userId))];
  const weeks = list.map((e) => mondayOf(e.date)).sort();
  const rows = await db.all(
    // a range of weeks, not a list: keeps the bound values under D1's 100
    `SELECT user_id, week_start FROM timesheet_weeks WHERE status = 'approved' AND user_id IN (${placeholders(users.length)}) AND week_start >= ? AND week_start <= ?`,
    [...users, weeks[0], weeks[weeks.length - 1]],
  );
  if (!rows.length) return;
  const locked = new Set(rows.map((r) => `${r.user_id} ${r.week_start}`));
  if (list.some((e) => locked.has(`${e.userId} ${mondayOf(e.date)}`))) fail(400, LOCKED_MESSAGE);
}

// ---- timer ----

export const TIMER_CONFIRM_HOURS = 12; // longer timers are not logged without the person confirming the hours

/** Elapsed time of a timer: whole minutes, rounded up (at least one), and the same in hours. */
export function elapsed(startedAt, nowMs) {
  const ms = Math.max(0, nowMs - Date.parse(startedAt));
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  return { minutes, hours: Math.round((minutes / 60) * 10000) / 10000 };
}

// ---- weeks ----

export function weekOut(w) {
  return {
    id: w.id,
    userId: w.user_id,
    weekStart: w.week_start,
    weekEnd: w.week_end,
    status: w.status,
    submittedAt: w.submitted_at,
    decidedAt: w.decided_at || null,
    decidedBy: w.decided_by ? { id: w.decided_by, name: w.decider_name || 'Former user' } : null,
    comment: w.comment || null,
    locked: w.status === 'approved',
  };
}

export const WEEK_SELECT = `SELECT tw.*, d.name AS decider_name FROM timesheet_weeks tw LEFT JOIN users d ON d.id = tw.decided_by`;

/**
 * May this person approve or reject the week? Workspace admins always; otherwise the lead of a project the
 * person logged time on in that week. Nobody but an admin decides their own week.
 */
export async function canDecide(db, actor, week) {
  if (actor.role === 'admin') return true;
  if (actor.role === 'guest' || week.user_id === actor.id) return false;
  const r = await db.get(
    `SELECT 1 AS ok FROM worklogs w JOIN issues i ON i.id = w.issue_id JOIN projects p ON p.id = i.project_id
      WHERE w.user_id = ? AND w.work_date >= ? AND w.work_date <= ? AND i.deleted_at IS NULL AND p.deleted_at IS NULL AND p.lead_id = ? LIMIT 1`,
    [week.user_id, week.week_start, week.week_end, actor.id],
  );
  return Boolean(r);
}
