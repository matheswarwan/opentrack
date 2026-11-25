// Project reports: sprint burndown, velocity, created vs resolved, cycle time, open issue breakdown.
//
// How past state is rebuilt: issue_history keeps one row per change with the old and new value
// (status and sprint as NAMES, story_points as numbers written as text). To know a field's value
// at time t we walk that issue's changes of the field in time order: the first change made after t
// tells us the value at t (its old value); with no change after t the value at t is the current value.
// This walks backwards from the current row, so it also works for issues created before the history
// had a given field, and for values set at creation (they have no change row).
//
// Assumptions and limits (also listed in the Reports tab help text):
// - An issue's story points at a given time are its current points unless story_points history says
//   otherwise. Issues without points count as 0 points (they still count in the issue series).
// - Sprint membership is matched by sprint NAME (history stores names). Renaming a sprint after the
//   fact, or two sprints with the same name, can confuse the reconstruction.
// - Status names in history are mapped to categories with the project's current statuses. A name
//   that no longer exists (renamed or deleted status) falls back to resolved_at for "done".
// - Issues in the Trash and deleted issues (with their history) do not appear in any report.
// - Sprint start time: the 'sprint.started' audit_log row when there is one (written by the start
//   route since reports were added), else 00:00 UTC on the sprint's start date. Days are UTC days.
// - Completing a sprint writes a 'sprint' history row for each unfinished issue it moves out (since
//   reports were added). Sprints completed before that lose the unfinished issues from their
//   reconstruction, so their burndown ends lower and their committed points can be too low.
// - resolved_at is the latest resolution: an issue reopened and resolved again counts once, in the
//   week of its last resolution.
// All date maths is done here in JS so the SQL stays portable (SQLite/D1 and Postgres).
import { fail } from './http.js';
import { DAY } from './time.js';
import { TYPES as TYPE_ORDER, PRIORITIES as PRIORITY_ORDER } from './issues/model.js';

const MAX_SPRINT_DAYS = 92;
const VELOCITY_SPRINTS = 6;
const CYCLE_BUCKETS = [
  { label: 'Under 1 day', min: 0, max: 1 },
  { label: '1 to 2 days', min: 1, max: 3 },
  { label: '3 to 5 days', min: 3, max: 6 },
  { label: '6 to 10 days', min: 6, max: 11 },
  { label: '11 to 20 days', min: 11, max: 21 },
  { label: '21 days or more', min: 21, max: Infinity },
];

const ms = (iso) => (iso ? Date.parse(iso) : null);
const dayMs = (date) => Date.parse(`${date}T00:00:00.000Z`);
const dayStr = (t) => new Date(t).toISOString().slice(0, 10);
const round1 = (n) => Math.round(n * 10) / 10;
const toPoints = (v) => {
  const n = v === null || v === undefined || v === '' ? 0 : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Monday 00:00 UTC of the week holding t. */
function weekStart(t) {
  const d = Math.floor(t / DAY) * DAY;
  const dow = (new Date(d).getUTCDay() + 6) % 7;
  return d - dow * DAY;
}

/** Linear interpolation percentile on a sorted array. */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * One issue's timeline. `events` are its status/sprint/story_points history rows, oldest first.
 * catOf maps a status name to its category (or undefined when the name is unknown).
 */
function timeline(issue, events, catOf) {
  const byField = { status: [], sprint: [], story_points: [] };
  for (const e of events) byField[e.field]?.push({ t: ms(e.created_at), from: e.old_value, to: e.new_value });
  const current = { status: issue.status_name, sprint: issue.sprint_name || null, story_points: issue.story_points };
  const created = ms(issue.created_at);
  const resolved = ms(issue.resolved_at);
  // value of a field at time t: the old value of the first change after t, else the current value
  const valueAt = (field, t) => {
    for (const e of byField[field]) if (e.t > t) return e.from;
    return current[field];
  };
  const tl = {
    issue,
    created,
    resolved,
    events: byField,
    exists: (t) => created <= t,
    sprintAt: (t) => (created <= t ? valueAt('sprint', t) : null),
    pointsAt: (t) => toPoints(valueAt('story_points', t)),
    doneAt(t) {
      const cat = catOf(valueAt('status', t));
      if (cat) return cat === 'done';
      return resolved !== null && resolved <= t;
    },
  };
  tl.inSprint = (t, name) => created <= t && tl.sprintAt(t) === name;
  return tl;
}

/** Start and last instants of a sprint, and its day list (UTC dates). */
function sprintWindow(s, startedAudit, nowMs) {
  const startDate = s.start_date || (startedAudit ? dayStr(startedAudit) : null);
  if (!startDate || s.state === 'future') return null;
  const startAt = startedAudit ?? dayMs(startDate);
  const closedAt = ms(s.completed_at);
  // the instant just before completion: completion moves unfinished issues out of the sprint
  const lastAt = closedAt !== null ? closedAt - 1 : nowMs;
  const plannedEnd = s.end_date && s.end_date >= startDate ? s.end_date : startDate;
  let lastDay = plannedEnd;
  const tail = dayStr(closedAt !== null ? closedAt : nowMs);
  if (tail > lastDay) lastDay = tail; // ran over: show the extra days
  const days = [];
  for (let d = dayMs(startDate); d <= dayMs(lastDay) && days.length < MAX_SPRINT_DAYS; d += DAY) days.push(dayStr(d));
  const plannedDays = Math.max(1, Math.min(days.length, Math.round((dayMs(plannedEnd) - dayMs(startDate)) / DAY) + 1));
  return { startAt, lastAt, closedAt, days, plannedDays, plannedEnd };
}

function sum(list, f) {
  return list.reduce((a, x) => a + f(x), 0);
}

function sprintBrief(s) {
  return { id: s.id, name: s.name, state: s.state, startDate: s.start_date, endDate: s.end_date, completedAt: s.completed_at };
}

function burndown(s, w, tls, nowMs) {
  const name = s.name;
  const committed = tls.filter((tl) => tl.inSprint(w.startAt, name));
  const committedPoints = sum(committed, (tl) => tl.pointsAt(w.startAt));
  const remainingAt = (t) => {
    const open = tls.filter((tl) => tl.inSprint(t, name) && !tl.doneAt(t));
    return { points: sum(open, (tl) => tl.pointsAt(t)), issues: open.length };
  };
  const days = w.days.map((date, i) => {
    const dayStartMs = dayMs(date);
    const ideal = i < w.plannedDays ? 1 - (i + 1) / w.plannedDays : 0;
    const out = {
      date,
      idealPoints: round1(committedPoints * ideal),
      idealIssues: round1(committed.length * ideal),
      remainingPoints: null,
      remainingIssues: null,
    };
    if (dayStartMs > nowMs) return out; // future day of an active sprint
    // state at the end of the day, but never before the start or after completion / now
    const t = Math.max(w.startAt, Math.min(dayStartMs + DAY - 1, w.lastAt));
    const r = remainingAt(t);
    out.remainingPoints = r.points;
    out.remainingIssues = r.issues;
    return out;
  });

  // scope changes: membership changes between start and the last instant, plus estimate changes
  const changes = [];
  for (const tl of tls) {
    const i = tl.issue;
    const base = { key: i.key, title: i.title };
    let member = tl.inSprint(w.startAt, name);
    // the moments membership can change: sprint history rows and the creation itself
    const moments = [...tl.events.sprint.map((e) => e.t), tl.created].filter((t) => t > w.startAt && t <= w.lastAt).sort((a, b) => a - b);
    for (const t of moments) {
      const now = tl.inSprint(t, name);
      if (now !== member)
        changes.push({
          ...base,
          at: new Date(t).toISOString(),
          date: dayStr(t),
          change: now ? 'added' : 'removed',
          points: tl.pointsAt(t),
        });
      member = now;
    }
    for (const e of tl.events.story_points) {
      if (e.t > w.startAt && e.t <= w.lastAt && tl.inSprint(e.t, name)) {
        changes.push({
          ...base,
          at: new Date(e.t).toISOString(),
          date: dayStr(e.t),
          change: 'points',
          from: toPoints(e.from),
          to: toPoints(e.to),
          points: toPoints(e.to) - toPoints(e.from),
        });
      }
    }
  }
  changes.sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));

  const atEnd = tls.filter((tl) => tl.inSprint(w.lastAt, name));
  const doneAtEnd = atEnd.filter((tl) => tl.doneAt(w.lastAt));
  return {
    sprint: sprintBrief(s),
    startedAt: new Date(w.startAt).toISOString(),
    start: { points: committedPoints, issues: committed.length },
    days,
    scopeChanges: changes,
    totals: {
      committedPoints,
      committedIssues: committed.length,
      addedPoints: sum(
        changes.filter((c) => c.change === 'added'),
        (c) => c.points,
      ),
      addedIssues: changes.filter((c) => c.change === 'added').length,
      removedPoints: sum(
        changes.filter((c) => c.change === 'removed'),
        (c) => c.points,
      ),
      removedIssues: changes.filter((c) => c.change === 'removed').length,
      estimateChangePoints: sum(
        changes.filter((c) => c.change === 'points'),
        (c) => c.points,
      ),
      completedPoints: sum(doneAtEnd, (tl) => tl.pointsAt(w.lastAt)),
      completedIssues: doneAtEnd.length,
      remainingPoints: sum(
        atEnd.filter((tl) => !tl.doneAt(w.lastAt)),
        (tl) => tl.pointsAt(w.lastAt),
      ),
      remainingIssues: atEnd.length - doneAtEnd.length,
      unestimatedIssues: atEnd.filter((tl) => tl.issue.story_points === null || tl.issue.story_points === undefined).length,
    },
  };
}

function velocity(closed, windows, tls) {
  const list = closed.slice(0, VELOCITY_SPRINTS).reverse(); // oldest first, for the chart
  const sprints = list.map((s) => {
    const w = windows.get(s.id);
    if (!w) return { sprint: sprintBrief(s), committedPoints: 0, completedPoints: 0, committedIssues: 0, completedIssues: 0 };
    const committed = tls.filter((tl) => tl.inSprint(w.startAt, s.name));
    const done = tls.filter((tl) => tl.inSprint(w.lastAt, s.name) && tl.doneAt(w.lastAt));
    return {
      sprint: sprintBrief(s),
      committedPoints: sum(committed, (tl) => tl.pointsAt(w.startAt)),
      completedPoints: sum(done, (tl) => tl.pointsAt(w.lastAt)),
      committedIssues: committed.length,
      completedIssues: done.length,
    };
  });
  const avg = sprints.length ? round1(sum(sprints, (x) => x.completedPoints) / sprints.length) : null;
  return { sprints, averageCompletedPoints: avg };
}

function flow(tls, weeks, nowMs) {
  const first = weekStart(nowMs) - (weeks - 1) * 7 * DAY;
  const rows = Array.from({ length: weeks }, (_, i) => ({ start: dayStr(first + i * 7 * DAY), created: 0, resolved: 0 }));
  const idx = (t) => (t === null || t < first ? -1 : Math.floor((t - first) / (7 * DAY)));
  for (const tl of tls) {
    const c = idx(tl.created);
    if (c >= 0 && c < weeks) rows[c].created++;
    const r = idx(tl.resolved);
    if (r >= 0 && r < weeks) rows[r].resolved++;
  }
  return { weeks: rows, from: dayStr(first), totals: { created: sum(rows, (r) => r.created), resolved: sum(rows, (r) => r.resolved) } };
}

function cycleTime(tls, catOf, weeks, nowMs) {
  const from = weekStart(nowMs) - (weeks - 1) * 7 * DAY;
  const items = [];
  for (const tl of tls) {
    if (tl.resolved === null || tl.resolved < from || tl.resolved > nowMs) continue;
    // start: first move out of a todo-category status; else when the issue was created
    const move = tl.events.status.find((e) => catOf(e.from) === 'todo' && catOf(e.to) !== 'todo' && e.t <= tl.resolved);
    const start = move ? move.t : tl.created;
    items.push({
      key: tl.issue.key,
      title: tl.issue.title,
      days: Math.max(0, (tl.resolved - start) / DAY),
      startedFrom: move ? 'status' : 'created',
    });
  }
  const sorted = items.map((x) => x.days).sort((a, b) => a - b);
  const r = (v) => (v === null ? null : round1(v));
  return {
    from: dayStr(from),
    issues: items.length,
    medianDays: r(percentile(sorted, 0.5)),
    p85Days: r(percentile(sorted, 0.85)),
    averageDays: sorted.length ? round1(sum(sorted, (x) => x) / sorted.length) : null,
    buckets: CYCLE_BUCKETS.map((b) => ({ label: b.label, count: sorted.filter((d) => d >= b.min && d < b.max).length })),
    slowest: items
      .sort((a, b) => b.days - a.days)
      .slice(0, 5)
      .map((x) => ({ ...x, days: round1(x.days) })),
  };
}

function breakdown(issues, statuses) {
  const open = issues.filter((i) => i.status_category !== 'done');
  const count = (f) => {
    const m = new Map();
    for (const i of open) {
      const k = f(i);
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  };
  const byStatus = count((i) => i.status_id);
  const byAssignee = count((i) => i.assignee_id || '');
  const byType = count((i) => i.type);
  const byPriority = count((i) => i.priority);
  const names = new Map(open.map((i) => [i.assignee_id || '', i.assignee_name || 'Unassigned']));
  return {
    open: open.length,
    byStatus: statuses
      .filter((s) => s.category !== 'done')
      .map((s) => ({ id: s.id, name: s.name, category: s.category, count: byStatus.get(s.id) || 0 })),
    byAssignee: [...byAssignee]
      .map(([id, n]) => ({ id: id || null, name: id ? names.get(id) : 'Unassigned', count: n }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    byType: TYPE_ORDER.filter((t) => byType.get(t)).map((t) => ({ type: t, count: byType.get(t) })),
    byPriority: PRIORITY_ORDER.filter((p) => byPriority.get(p)).map((p) => ({ priority: p, count: byPriority.get(p) })),
  };
}

export async function projectReports(db, project, { sprint: sprintParam, weeks: weeksParam } = {}, nowMs = Date.now()) {
  const weeks = Math.min(52, Math.max(1, Number.parseInt(weeksParam, 10) || 12));
  const [statuses, sprints, issues, history, audits] = await Promise.all([
    db.all('SELECT id, name, category, position FROM statuses WHERE project_id = ? ORDER BY position', [project.id]),
    db.all('SELECT * FROM sprints WHERE project_id = ? ORDER BY created_at', [project.id]),
    db.all(
      `SELECT i.id, i.key, i.title, i.type, i.priority, i.status_id, s.name AS status_name, s.category AS status_category,
              i.assignee_id, u.name AS assignee_name, i.story_points, i.created_at, i.resolved_at, i.sprint_id, sp.name AS sprint_name
         FROM issues i JOIN statuses s ON s.id = i.status_id LEFT JOIN users u ON u.id = i.assignee_id
         LEFT JOIN sprints sp ON sp.id = i.sprint_id
        WHERE i.project_id = ? AND i.deleted_at IS NULL`,
      [project.id],
    ),
    db.all(
      `SELECT h.issue_id, h.field, h.old_value, h.new_value, h.created_at FROM issue_history h JOIN issues i ON i.id = h.issue_id
        WHERE i.project_id = ? AND i.deleted_at IS NULL AND h.field IN ('status', 'sprint', 'story_points') ORDER BY h.created_at`,
      [project.id],
    ),
    db.all(
      `SELECT a.target_id, a.created_at FROM audit_log a JOIN sprints s ON s.id = a.target_id
        WHERE s.project_id = ? AND a.action = 'sprint.started'`,
      [project.id],
    ),
  ]);

  const cats = new Map(statuses.map((s) => [s.name.toLowerCase(), s.category]));
  const catOf = (name) => (name === null || name === undefined ? undefined : cats.get(String(name).toLowerCase()));
  const evByIssue = new Map();
  for (const h of history) {
    if (!evByIssue.has(h.issue_id)) evByIssue.set(h.issue_id, []);
    evByIssue.get(h.issue_id).push(h);
  }
  for (const list of evByIssue.values()) list.sort((a, b) => ms(a.created_at) - ms(b.created_at));
  const tls = issues.map((i) => timeline(i, evByIssue.get(i.id) || [], catOf));

  const started = new Map();
  for (const a of audits) started.set(a.target_id, Math.max(started.get(a.target_id) ?? 0, ms(a.created_at)));
  const windows = new Map();
  for (const s of sprints) {
    const w = sprintWindow(s, started.get(s.id) ?? null, nowMs);
    if (w) windows.set(s.id, w);
  }
  const closed = sprints.filter((s) => s.state === 'closed').sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || ''));
  const active = sprints.find((s) => s.state === 'active');

  let chosen = null;
  if (sprintParam && sprintParam !== 'active') {
    chosen = sprints.find((s) => s.id === sprintParam);
    if (!chosen) fail(404, 'Sprint not found');
  } else {
    chosen = active || closed[0] || null;
  }
  let burn;
  if (!chosen) burn = { sprint: null, empty: 'no_sprint' };
  else if (!windows.has(chosen.id)) burn = { sprint: sprintBrief(chosen), empty: 'not_started' };
  else burn = burndown(chosen, windows.get(chosen.id), tls, nowMs);

  return {
    project: { id: project.id, key: project.key, name: project.name },
    generatedAt: new Date(nowMs).toISOString(),
    weeks,
    sprints: [...(active ? [active] : []), ...closed].map(sprintBrief),
    burndown: burn,
    velocity: velocity(closed, windows, tls),
    flow: flow(tls, weeks, nowMs),
    cycleTime: cycleTime(tls, catOf, weeks, nowMs),
    breakdown: breakdown(issues, statuses),
  };
}
