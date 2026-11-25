// Capacity planning (migration 0028; routes in server/routes/capacity.js).
//
// Availability: each person has weekly capacity hours (user_capacity, else the workspace setting
// defaultCapacityHours). Hours per weekday = weekly / 5; Saturdays and Sundays count 0; time-off days count 0.
// In the current week only today and later count.
//
// Allocation: the share of a person's capacity a project gets (project_allocations.pct, 0 to 100). Without a row the
// person is not allocated there: their unallocated projects share evenly what the explicit allocations leave, so a
// person in one project gets 100%.
//
// Booked work: open issues (status category not done, not epics, not deleted, project not archived) assigned to the
// person. Remaining = max(estimate - logged, 0). It is spread evenly over the weekdays from the issue's start date
// (or today, whichever is later) to its due date; without a due date, from today (or the sprint start) to the end of
// its sprint (active or future, when the sprint has an end date); otherwise it is unscheduled. Overdue work lands
// today. Work after the last week shown is "later".
//
// Levels (booked / available): under 70% light, 70-100% good, over 100% over, over 120% overloaded.
import { addDays, mondayOf } from './time.js';
import { placeholders, inChunks } from '../db/sql.js';

const dayMs = (d) => Date.parse(`${d}T00:00:00.000Z`);
export const isWeekday = (d) => {
  const w = new Date(dayMs(d)).getUTCDay();
  return w !== 0 && w !== 6;
};
export const DEFAULT_WEEKS = 8;
export const MAX_WEEKS = 12;
const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

/** Weekdays from a to b, both included. */
export function weekdays(a, b) {
  const out = [];
  for (let d = a; d <= b; d = addDays(d, 1)) if (isWeekday(d)) out.push(d);
  return out;
}

/** booked / available as a level. */
export function level(booked, available) {
  if (available <= 0) return booked > 0 ? { pct: null, level: 'overloaded' } : { pct: null, level: 'none' };
  const pct = Math.round((booked / available) * 100);
  return { pct, level: pct > 120 ? 'overloaded' : pct > 100 ? 'over' : pct >= 70 ? 'good' : 'light' };
}

/**
 * Effective share per project for one person. rows: [{ project_id, pct (null = not allocated) }].
 * Returns Map projectId -> { share, set }.
 */
export function shares(rows) {
  const explicit = rows.filter((r) => r.pct !== null && r.pct !== undefined);
  const used = explicit.reduce((s, r) => s + Number(r.pct), 0);
  const open = rows.length - explicit.length;
  const each = open ? Math.max(0, 100 - used) / open : 0;
  return new Map(
    rows.map((r) =>
      r.pct !== null && r.pct !== undefined
        ? [r.project_id, { share: Number(r.pct), set: true }]
        : [r.project_id, { share: Math.round(each * 10) / 10, set: false }],
    ),
  );
}

/**
 * Where an issue's remaining hours go: { days: [dates] } or { unscheduled: true }.
 * issue: { start_date, due_date, sprint_state, sprint_start, sprint_end }.
 */
export function issueWindow(issue, today) {
  let from;
  let to;
  if (issue.due_date) {
    from = issue.start_date && issue.start_date > today ? issue.start_date : today;
    to = issue.due_date;
  } else if (issue.sprint_end && (issue.sprint_state === 'active' || issue.sprint_state === 'future')) {
    const start = [issue.start_date, issue.sprint_start].filter(Boolean).sort().pop();
    from = start && start > today ? start : today;
    to = issue.sprint_end;
  } else return { unscheduled: true };
  if (to < from) from = to = today; // overdue: due now
  let days = weekdays(from, to);
  if (!days.length) {
    // a weekend-only window: the next weekday
    let d = from;
    while (!isWeekday(d)) d = addDays(d, 1);
    days = [d];
  }
  return { days };
}

/** Available hours per week for one person: weeks [{ start }], daily hours, time-off rows. Returns [{ available, awayDays }]. */
export function availability(weeks, today, daily, timeOff, share = 100) {
  return weeks.map((w) => {
    const days = weekdays(w.start, addDays(w.start, 4));
    const away = (d) => timeOff.some((t) => t.start_date <= d && t.end_date >= d);
    const awayDays = days.filter(away).length;
    const working = days.filter((d) => d >= today && !away(d)).length;
    return { available: r1(working * daily * (share / 100)), awayDays };
  });
}

/** Run a query once per chunk of ids and concatenate. build(ids) -> [sql, params]. */
export function chunked(db, ids, build) {
  return inChunks(ids, (part) => {
    const [sql, params] = build(part);
    return db.all(sql, params);
  });
}

/**
 * Everything the grid needs for these people, in four queries per 80 people:
 * capacity rows, time off in the range, project memberships with allocations, and open estimated issues.
 * opts: { from, to (time-off range), projectId (only this project's issues), visible: { sql, params } (alias p) }.
 */
export async function loadInputs(db, ids, opts) {
  const vis = opts.visible || { sql: '1 = 1', params: [] };
  const [caps, off, members, issues] = await Promise.all([
    chunked(db, ids, (p) => [`SELECT user_id, weekly_hours FROM user_capacity WHERE user_id IN (${placeholders(p.length)})`, p]),
    chunked(db, ids, (p) => [
      `SELECT id, user_id, start_date, end_date, note FROM time_off WHERE user_id IN (${placeholders(p.length)}) AND end_date >= ? AND start_date <= ? ORDER BY start_date`,
      [...p, opts.from, opts.to],
    ]),
    chunked(db, ids, (p) => [
      `SELECT m.project_id, m.user_id, a.pct FROM project_members m JOIN projects p ON p.id = m.project_id
         LEFT JOIN project_allocations a ON a.project_id = m.project_id AND a.user_id = m.user_id
        WHERE p.archived = 0 AND m.user_id IN (${placeholders(p.length)})`,
      p,
    ]),
    opts.skipIssues
      ? []
      : chunked(db, ids, (p) => [
          `SELECT i.id, i.key, i.title, i.type, i.assignee_id, i.project_id, p.key AS project_key, i.estimate_hours, i.start_date, i.due_date,
              sp.state AS sprint_state, sp.start_date AS sprint_start, sp.end_date AS sprint_end,
              CAST(COALESCE((SELECT SUM(w.hours) FROM worklogs w WHERE w.issue_id = i.id), 0) AS DOUBLE PRECISION) AS logged,
              CASE WHEN ${vis.sql} THEN 1 ELSE 0 END AS visible
         FROM issues i JOIN statuses s ON s.id = i.status_id JOIN projects p ON p.id = i.project_id
         LEFT JOIN sprints sp ON sp.id = i.sprint_id
        WHERE i.deleted_at IS NULL AND s.category <> 'done' AND i.type <> 'epic' AND p.archived = 0
          ${opts.projectId ? 'AND i.project_id = ?' : ''} AND i.assignee_id IN (${placeholders(p.length)})`,
          [...vis.params, ...(opts.projectId ? [opts.projectId] : []), ...p],
        ]),
  ]);
  return { caps, off, members, issues };
}

/**
 * The grid. people: [{ id, name, ... }]. inputs: loadInputs(). Returns rows with weeks, unscheduled, later and issues.
 * opts: { weeks: [{ start }], today, defaultHours, projectId, showNotes(personId) -> bool }.
 */
export function buildGrid(people, inputs, opts) {
  const { weeks, today, defaultHours, projectId } = opts;
  const weekIndex = new Map(weeks.map((w, i) => [w.start, i]));
  const capOf = new Map(inputs.caps.map((r) => [r.user_id, Number(r.weekly_hours)]));
  const offOf = groupBy(inputs.off, 'user_id');
  const memOf = groupBy(inputs.members, 'user_id');
  const issuesOf = groupBy(inputs.issues, 'assignee_id');
  return people.map((person) => {
    const weekly = capOf.has(person.id) ? capOf.get(person.id) : defaultHours;
    const timeOff = offOf.get(person.id) || [];
    const sh = projectId ? shares(memOf.get(person.id) || []).get(projectId) || { share: 0, set: false } : null;
    const avail = availability(weeks, today, weekly / 5, timeOff, sh ? sh.share : 100);
    const booked = weeks.map(() => 0);
    let unscheduled = 0;
    let later = 0;
    let unestimated = 0;
    const issues = [];
    const elsewhere = { weeks: {}, unscheduled: 0, later: 0, count: 0 };
    for (const i of issuesOf.get(person.id) || []) {
      if (i.estimate_hours === null || i.estimate_hours === undefined) {
        unestimated++;
        continue;
      }
      const remaining = Math.max(0, Number(i.estimate_hours) - (Number(i.logged) || 0));
      if (remaining <= 0) continue;
      const win = issueWindow(i, today);
      const out = { weeks: {}, unscheduled: 0, later: 0 };
      if (win.unscheduled) out.unscheduled = remaining;
      else {
        const per = remaining / win.days.length;
        for (const d of win.days) {
          const k = weekIndex.get(mondayOf(d));
          if (k === undefined) {
            if (d > weeks[weeks.length - 1].start) out.later += per;
            continue;
          }
          out.weeks[weeks[k].start] = (out.weeks[weeks[k].start] || 0) + per;
          booked[k] += per;
        }
      }
      unscheduled += out.unscheduled;
      later += out.later;
      if (Number(i.visible)) {
        issues.push({
          key: i.key,
          title: i.title,
          type: i.type,
          projectKey: i.project_key,
          remaining: r1(remaining),
          estimate: Number(i.estimate_hours),
          logged: r1(i.logged),
          startDate: i.start_date || null,
          dueDate: i.due_date || null,
          weeks: Object.fromEntries(Object.entries(out.weeks).map(([k, v]) => [k, r1(v)])),
          unscheduled: r1(out.unscheduled),
          later: r1(out.later),
        });
      } else {
        elsewhere.count++;
        for (const [k, v] of Object.entries(out.weeks)) elsewhere.weeks[k] = (elsewhere.weeks[k] || 0) + v;
        elsewhere.unscheduled += out.unscheduled;
        elsewhere.later += out.later;
      }
    }
    const showNotes = opts.showNotes ? opts.showNotes(person.id) : false;
    return {
      ...person,
      weeklyHours: weekly,
      custom: capOf.has(person.id),
      share: sh ? sh.share : null,
      shareSet: sh ? sh.set : null,
      weeks: weeks.map((w, k) => ({
        start: w.start,
        available: avail[k].available,
        booked: r1(booked[k]),
        awayDays: avail[k].awayDays,
        ...level(booked[k], avail[k].available),
      })),
      unscheduled: r1(unscheduled),
      later: r1(later),
      unestimated,
      timeOff: timeOff.map((t) =>
        showNotes
          ? { id: t.id, startDate: t.start_date, endDate: t.end_date, note: t.note || '' }
          : { startDate: t.start_date, endDate: t.end_date, away: true },
      ),
      issues: issues.sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || a.key.localeCompare(b.key)),
      elsewhere: elsewhere.count
        ? {
            count: elsewhere.count,
            weeks: Object.fromEntries(Object.entries(elsewhere.weeks).map(([k, v]) => [k, r1(v)])),
            unscheduled: r1(elsewhere.unscheduled),
            later: r1(elsewhere.later),
          }
        : null,
    };
  });
}

function groupBy(rows, key) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r[key])) m.set(r[key], []);
    m.get(r[key]).push(r);
  }
  return m;
}

/** The weeks shown: count Mondays from the week holding `from`. */
export function weekList(from, count) {
  const first = mondayOf(from);
  return Array.from({ length: count }, (_, i) => {
    const start = addDays(first, i * 7);
    return { start, end: addDays(start, 4) };
  });
}

/**
 * Team hours for a project's open sprints (backlog hint): available hours of the project's non-guest members in each
 * sprint's dates (from today for the active sprint) times their share, against the sprint's estimated remaining.
 */
export async function sprintCapacity(db, project, { today, defaultHours }) {
  const [sprints, members] = await Promise.all([
    db.all(
      `SELECT id, state, start_date, end_date FROM sprints WHERE project_id = ? AND state <> 'closed' AND start_date IS NOT NULL AND end_date IS NOT NULL`,
      [project.id],
    ),
    db.all(
      `SELECT u.id FROM project_members m JOIN users u ON u.id = m.user_id
        WHERE m.project_id = ? AND u.role <> 'guest' AND u.status <> 'deactivated' AND u.is_system = 0`,
      [project.id],
    ),
  ]);
  if (!sprints.length) return { sprints: [] };
  const ids = members.map((m) => m.id);
  const from = sprints.map((s) => s.start_date).sort()[0];
  const to = sprints
    .map((s) => s.end_date)
    .sort()
    .pop();
  const [inputs, remainingRows] = await Promise.all([
    ids.length ? loadInputs(db, ids, { from, to, skipIssues: true }) : { caps: [], off: [], members: [] },
    db.all(
      `SELECT x.sprint_id, CAST(SUM(CASE WHEN x.est > x.logged THEN x.est - x.logged ELSE 0 END) AS DOUBLE PRECISION) AS remaining,
              CAST(SUM(CASE WHEN x.est IS NULL THEN 1 ELSE 0 END) AS INTEGER) AS unestimated
         FROM (SELECT i.sprint_id, i.estimate_hours AS est,
                      COALESCE((SELECT SUM(w.hours) FROM worklogs w WHERE w.issue_id = i.id), 0) AS logged
                 FROM issues i JOIN statuses s ON s.id = i.status_id
                WHERE i.project_id = ? AND i.sprint_id IS NOT NULL AND i.deleted_at IS NULL AND s.category <> 'done' AND i.type <> 'epic') x
        GROUP BY x.sprint_id`,
      [project.id],
    ),
  ]);
  const capOf = new Map(inputs.caps.map((r) => [r.user_id, Number(r.weekly_hours)]));
  const offOf = groupBy(inputs.off, 'user_id');
  const memOf = groupBy(inputs.members, 'user_id');
  const remOf = new Map(remainingRows.map((r) => [r.sprint_id, r]));
  return {
    sprints: sprints.map((s) => {
      const start = s.state === 'active' && today > s.start_date ? today : s.start_date;
      const days = weekdays(start, s.end_date);
      let available = 0;
      for (const id of ids) {
        const share = (shares(memOf.get(id) || []).get(project.id) || { share: 0 }).share;
        const off = offOf.get(id) || [];
        const working = days.filter((d) => !off.some((t) => t.start_date <= d && t.end_date >= d)).length;
        available += working * ((capOf.has(id) ? capOf.get(id) : defaultHours) / 5) * (share / 100);
      }
      const rem = remOf.get(s.id);
      const remaining = r1(rem?.remaining);
      return {
        id: s.id,
        from: start,
        to: s.end_date,
        people: ids.length,
        available: r1(available),
        remaining,
        unestimated: Number(rem?.unestimated) || 0,
        ...level(remaining, r1(available)),
      };
    }),
  };
}
