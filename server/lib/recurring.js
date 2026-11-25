// Recurring issues: schedule maths, plain-English summaries and the daily `recurring` job (see server/lib/jobs.js).
//
// A schedule is JSON in recurring_rules.schedule, one of:
//   { freq: 'daily', weekdaysOnly: false }        every day (or Monday to Friday only)
//   { freq: 'weekly', weekdays: [1, 4] }          on these weekdays (0 = Sunday ... 6 = Saturday)
//   { freq: 'monthly', monthly: 'day', day: 15 }  on day N (the last day in months that are shorter)
//   { freq: 'monthly', monthly: 'last_day' }      on the last day of the month
//   { freq: 'monthly', monthly: 'last_weekday' }  on the last Monday to Friday of the month
//   { freq: 'yearly', month: 11, day: 24 }        once a year (29 February: the 28th in other years)
// Dates are local dates (YYYY-MM-DD) in the workspace time zone (timeZone setting).
//
// The job creates every due occurrence from up to CATCH_UP_DAYS back to today (never before the rule's start date
// or the day it was made). recurring_occurrences has UNIQUE (rule_id, occurs_on), and the row is written in the same
// batch as the issue, so a rule never creates two issues for one date, even when two runs overlap.
import { uuid } from './crypto.js';
import { fail, str, oneOf, isoDate, detachedContext } from './http.js';
import { addDays, localParts } from './time.js';
import { historyStmt } from './history.js';
import { noticeStmts } from './notifications.js';
import { allocate, firstStatus, issueInsertStatements, announceCreated } from './issues/create.js';
import { reachable } from './issues/guards.js';
import { cleanLabels, mentionedIds, TYPES, PRIORITIES } from './issues/model.js';
import { applyTitlePrefix, SUBTASK_PARENTS, MAX_SUBTASKS } from './issues/templates.js';
import { placeholders } from '../db/sql.js';
import { parseList } from './json.js';

export const CATCH_UP_DAYS = 7;
export const MAX_RULES = 100;
export const FREQS = ['daily', 'weekly', 'monthly', 'yearly'];
export const MONTHLY = ['day', 'last_day', 'last_weekday'];
export const SPRINTS = ['backlog', 'active'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

// ---- dates ----

const ymd = (date) => date.split('-').map(Number);
export const weekdayOf = (date) => {
  const [y, m, d] = ymd(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};
export const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** ISO 8601 week number of a date. */
export function isoWeek(date) {
  const [y, m, d] = ymd(date);
  const t = new Date(Date.UTC(y, m - 1, d));
  const wd = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - wd);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  return Math.ceil(((t - yearStart) / 864e5 + 1) / 7);
}

/** 24 Nov 2026 */
export function shortDate(date) {
  const [y, m, d] = ymd(date);
  return `${d} ${MONTH_NAMES[m - 1].slice(0, 3)} ${y}`;
}

function lastWeekdayOfMonth(y, m) {
  let d = lastDayOfMonth(y, m);
  const pad = (n) => String(n).padStart(2, '0');
  while ([0, 6].includes(weekdayOf(`${y}-${pad(m)}-${pad(d)}`))) d--;
  return d;
}

/** Does the schedule fall on this date (ignoring start, end and count)? */
export function matches(s, date) {
  const [y, m, d] = ymd(date);
  const wd = weekdayOf(date);
  switch (s.freq) {
    case 'daily':
      return !s.weekdaysOnly || (wd >= 1 && wd <= 5);
    case 'weekly':
      return (s.weekdays || []).includes(wd);
    case 'monthly':
      if (s.monthly === 'last_day') return d === lastDayOfMonth(y, m);
      if (s.monthly === 'last_weekday') return d === lastWeekdayOfMonth(y, m);
      return d === Math.min(Number(s.day), lastDayOfMonth(y, m));
    case 'yearly':
      return m === Number(s.month) && d === Math.min(Number(s.day), lastDayOfMonth(y, m));
    default:
      return false;
  }
}

/**
 * The next `n` dates from `from` (included) that the rule would create, respecting its end date and count.
 * `rule` uses the API shape or the row shape: { schedule, startDate|start_date, endDate|end_date, maxCount|max_count, createdCount|created_count }.
 */
export function nextDates(rule, from, n = 5) {
  const s = typeof rule.schedule === 'string' ? JSON.parse(rule.schedule) : rule.schedule;
  const start = rule.startDate ?? rule.start_date;
  const end = rule.endDate ?? rule.end_date ?? null;
  const max = rule.maxCount ?? rule.max_count ?? null;
  const made = Number(rule.createdCount ?? rule.created_count ?? 0);
  const left = max === null || max === undefined ? Infinity : Math.max(0, Number(max) - made);
  const out = [];
  let d = from > start ? from : start;
  for (let i = 0; i < 800 && out.length < Math.min(n, left); i++, d = addDays(d, 1)) {
    if (end && d > end) break;
    if (matches(s, d)) out.push(d);
  }
  return out;
}

const joinWords = (list) => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

/** "Every Monday and Thursday", "Every month on the last day" ... */
export function describeSchedule(s) {
  switch (s.freq) {
    case 'daily':
      return s.weekdaysOnly ? 'Every weekday (Monday to Friday)' : 'Every day';
    case 'weekly': {
      const days = [...(s.weekdays || [])].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)); // Monday first
      if (days.length === 7) return 'Every day';
      if (days.length === 5 && [1, 2, 3, 4, 5].every((x) => days.includes(x))) return 'Every weekday (Monday to Friday)';
      return `Every ${joinWords(days.map((x) => DAY_NAMES[x]))}`;
    }
    case 'monthly':
      if (s.monthly === 'last_day') return 'Every month on the last day';
      if (s.monthly === 'last_weekday') return 'Every month on the last weekday (Monday to Friday)';
      return `Every month on day ${s.day}${Number(s.day) > 28 ? ' (the last day in shorter months)' : ''}`;
    case 'yearly':
      return `Every year on ${s.day} ${MONTH_NAMES[Number(s.month) - 1]}${Number(s.month) === 2 && Number(s.day) === 29 ? ' (28 February in other years)' : ''}`;
    default:
      return '';
  }
}

/** Summary plus limits: "Every Monday, from 1 Dec 2026, until 31 Dec 2027, 10 issues at most". */
export function describeRule(rule) {
  const s = typeof rule.schedule === 'string' ? JSON.parse(rule.schedule) : rule.schedule;
  const parts = [describeSchedule(s)];
  const end = rule.endDate ?? rule.end_date;
  const max = rule.maxCount ?? rule.max_count;
  if (end) parts.push(`until ${shortDate(end)}`);
  if (max) parts.push(`${max} ${Number(max) === 1 ? 'issue' : 'issues'} at most`);
  return parts.join(', ');
}

/** Replace {date}, {month}, {year} and {week} in a title with the occurrence date's values. */
export function renderTitle(title, date) {
  const [y, m] = ymd(date);
  return String(title)
    .replace(/\{date\}/g, date)
    .replace(/\{month\}/g, MONTH_NAMES[m - 1])
    .replace(/\{year\}/g, String(y))
    .replace(/\{week\}/g, String(isoWeek(date)));
}

// ---- validation ----

/** Validate a schedule object from the API; returns a clean copy. */
export function readSchedule(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(400, 'schedule is required');
  const freq = oneOf(v.freq, FREQS, 'Repeat');
  if (!freq) fail(400, 'Repeat is required');
  const whole = (x, min, max, name) => {
    const n = Number(x);
    if (!Number.isInteger(n) || n < min || n > max) fail(400, `${name} must be a whole number from ${min} to ${max}`);
    return n;
  };
  if (freq === 'daily') return { freq, weekdaysOnly: Boolean(v.weekdaysOnly) };
  if (freq === 'weekly') {
    if (!Array.isArray(v.weekdays) || !v.weekdays.length) fail(400, 'Pick at least one day of the week');
    return { freq, weekdays: [...new Set(v.weekdays.map((x) => whole(x, 0, 6, 'Day of the week')))].sort() };
  }
  if (freq === 'monthly') {
    const monthly = oneOf(v.monthly || 'day', MONTHLY, 'Day of the month');
    return monthly === 'day' ? { freq, monthly, day: whole(v.day, 1, 31, 'Day of the month') } : { freq, monthly };
  }
  const month = whole(v.month, 1, 12, 'Month');
  const day = whole(v.day, 1, 31, 'Day');
  if (day > lastDayOfMonth(2024, month)) fail(400, `${MONTH_NAMES[month - 1]} has no day ${day}`);
  return { freq, month, day };
}

/** Validate a rule from the API. current: the row for PATCH (only the fields sent change). Returns column values. */
export async function readRule(db, b, current, project, today) {
  const out = {};
  const has = (k) => !current || b[k] !== undefined;
  if (has('title')) out.title = str(b.title, { required: true, max: 255, name: 'Title' });
  if (has('name') || (!current && !b.name)) {
    out.name = str(b.name, { max: 80, name: 'Name' }) || (out.title || current?.title || '').slice(0, 80);
    if (!out.name) fail(400, 'Name is required');
  }
  if (has('type')) {
    out.type = oneOf(b.type || 'task', TYPES, 'Type');
    if (out.type === 'subtask')
      fail(400, 'A recurring rule cannot create sub-tasks on their own. Add them as sub-tasks of a story, task or bug.');
  }
  if (b.description !== undefined) out.description = str(b.description, { max: 50000, name: 'Description' }) || null;
  if (has('priority')) out.priority = oneOf(b.priority || 'medium', PRIORITIES, 'Priority');
  if (b.assigneeId !== undefined) {
    if (b.assigneeId) {
      const u = await db.get(`SELECT id FROM users WHERE id = ? AND status <> 'deactivated'`, [b.assigneeId]);
      if (!u) fail(400, 'Assignee not found');
      // a guest can be the assignee only in a project they are a member of
      const outsider = await db.get(
        `SELECT 1 AS x FROM users g WHERE g.id = ? AND g.role = 'guest'
        AND NOT EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = ? AND m.user_id = g.id)`,
        [u.id, project.id],
      );
      if (outsider) fail(400, 'This guest is not a member of the project');
      out.assignee_id = u.id;
    } else out.assignee_id = null;
  }
  if (b.labels !== undefined) out.labels = JSON.stringify(cleanLabels(b.labels || []));
  if (b.templateId !== undefined) {
    if (b.templateId) {
      const t = await db.get('SELECT id FROM issue_templates WHERE id = ? AND project_id = ?', [b.templateId, project.id]);
      if (!t) fail(400, 'Template not found');
      out.template_id = t.id;
    } else out.template_id = null;
  }
  if (b.subtasks !== undefined) {
    if (b.subtasks !== null && !Array.isArray(b.subtasks)) fail(400, 'subtasks must be a list of titles');
    const list = (b.subtasks || []).map((s) => String(s).trim()).filter(Boolean);
    if (list.length > MAX_SUBTASKS) fail(400, `At most ${MAX_SUBTASKS} sub-tasks`);
    if (list.some((s) => s.length > 255)) fail(400, 'Sub-task titles are at most 255 characters');
    out.subtasks = JSON.stringify(list);
  }
  const type = out.type ?? current?.type ?? 'task';
  if (JSON.parse(out.subtasks ?? current?.subtasks ?? '[]').length && !SUBTASK_PARENTS.includes(type))
    fail(400, 'Only stories, tasks and bugs can have sub-tasks');
  if (has('sprint')) out.sprint = oneOf(b.sprint || 'backlog', SPRINTS, 'Sprint');
  if (b.dueDays !== undefined) {
    if (b.dueDays === null || b.dueDays === '') out.due_days = null;
    else {
      const n = Number(b.dueDays);
      if (!Number.isInteger(n) || n < 0 || n > 365) fail(400, 'Due after must be a whole number of days from 0 to 365');
      out.due_days = n;
    }
  }
  if (has('schedule')) out.schedule = JSON.stringify(readSchedule(b.schedule));
  if (has('startDate')) out.start_date = isoDate(b.startDate, 'Start date') || today;
  if (b.endDate !== undefined) out.end_date = isoDate(b.endDate, 'End date') || null;
  const start = out.start_date ?? current?.start_date;
  const end = out.end_date !== undefined ? out.end_date : current?.end_date;
  if (end && end < start) fail(400, 'The end date is before the start date');
  if (b.maxCount !== undefined) {
    if (b.maxCount === null || b.maxCount === '') out.max_count = null;
    else {
      const n = Number(b.maxCount);
      if (!Number.isInteger(n) || n < 1 || n > 10000) fail(400, 'Number of issues must be a whole number from 1 to 10000');
      out.max_count = n;
    }
  }
  if (b.paused !== undefined) out.paused = b.paused ? 1 : 0;
  return out;
}

// ---- creating occurrences ----

/** Rule rows with what the job needs: project key and lead, the creator and a live assignee. */
export const RULE_JOB_SELECT = `SELECT r.*, p.key AS project_key, p.lead_id AS project_lead, p.archived AS project_archived,
    cu.name AS creator_name, cu.status AS creator_status, a.id AS live_assignee
  FROM recurring_rules r JOIN projects p ON p.id = r.project_id
  LEFT JOIN users cu ON cu.id = r.created_by
  LEFT JOIN users a ON a.id = r.assignee_id AND a.status <> 'deactivated'`;

/** Dates a rule still has to create on `today`: catch-up window, start, end, count and the dates already made. */
export function dueDates(rule, today, tz, existing = new Set()) {
  const made = localParts(new Date(rule.created_at).getTime(), tz).date;
  let from = addDays(today, -CATCH_UP_DAYS);
  if (rule.start_date > from) from = rule.start_date;
  if (made > from) from = made;
  const out = [];
  const left =
    rule.max_count === null || rule.max_count === undefined ? Infinity : Number(rule.max_count) - Number(rule.created_count || 0);
  const s = JSON.parse(rule.schedule);
  for (let d = from; d <= today && out.length < left; d = addDays(d, 1)) {
    if (rule.end_date && d > rule.end_date) break;
    if (matches(s, d) && !existing.has(d)) out.push(d);
  }
  return out;
}

/**
 * Create the issue (and its sub-tasks) for one occurrence. `cache` keeps project statuses, sprints, templates
 * and actors between calls in one slice. Returns { key } or { skipped: reason }.
 */
/**
 * Create the issue (and its sub-tasks) of one rule for one date, in one batch. Returns { key, subtasks, created } or
 * { skipped: why }. `created` is what announceOccurrence needs.
 */
export async function createOccurrence(db, rule, date, t, cache = {}) {
  const memo = async (k, fn) => {
    if (!(k in cache)) cache[k] = await fn();
    return cache[k];
  };
  // The person the issue is created as: the rule's maker while active, else the project lead.
  let actor = rule.created_by && rule.creator_status === 'active' ? { id: rule.created_by, name: rule.creator_name } : null;
  if (!actor && rule.project_lead) {
    actor = await memo(`lead:${rule.project_lead}`, () =>
      db.get(`SELECT id, name FROM users WHERE id = ? AND status = 'active'`, [rule.project_lead]),
    );
  }
  if (!actor) return { skipped: 'nobody to create it as' };
  const status = await memo(`status:${rule.project_id}`, () => firstStatus(db, rule.project_id));
  if (!status) return { skipped: 'the project has no statuses' };
  const sprintId =
    rule.sprint === 'active'
      ? (
          await memo(`sprint:${rule.project_id}`, () =>
            db.get(`SELECT id FROM sprints WHERE project_id = ? AND state = 'active' LIMIT 1`, [rule.project_id]),
          )
        )?.id || null
      : null;
  const tpl = rule.template_id
    ? await memo(`tpl:${rule.template_id}`, () => db.get('SELECT * FROM issue_templates WHERE id = ?', [rule.template_id]))
    : null;

  const title = applyTitlePrefix(tpl?.title_prefix, renderTitle(rule.title, date)).slice(0, 255);
  const labels = [...new Set([...parseList(tpl?.labels), ...parseList(rule.labels)])].slice(0, 20);
  const subtasks = SUBTASK_PARENTS.includes(rule.type)
    ? [...parseList(tpl?.subtasks), ...parseList(rule.subtasks)].slice(0, MAX_SUBTASKS)
    : [];
  const dueDate = rule.due_days === null || rule.due_days === undefined ? null : addDays(date, Number(rule.due_days));
  const project = { id: rule.project_id, key: rule.project_key };

  const slot = await allocate(db, project, 1 + subtasks.length);
  const id = uuid();
  const key = `${project.key}-${slot.first}`;
  const description = rule.description || tpl?.description || null;
  const assigneeId = rule.live_assignee || null;
  const common = {
    project,
    actor,
    t,
    statusId: status.id,
    done: status.category === 'done',
    priority: rule.priority,
    reporterId: actor.id,
    sprintId,
    storyPoints: null,
    estimateHours: null,
    dueDate,
  };
  const main = issueInsertStatements({
    ...common,
    id,
    number: slot.number(0),
    rank: slot.rank(0),
    type: rule.type,
    title,
    description,
    assigneeId,
    parentId: null,
    labels,
  });
  const stmts = [...main.stmts, historyStmt(id, actor.id, 'recurring', null, `Created by recurring rule ${rule.name}`.slice(0, 2000), t)];
  const notes = [...main.notices];
  subtasks.forEach((st, k) => {
    const sub = issueInsertStatements({
      ...common,
      id: uuid(),
      number: slot.number(k + 1),
      rank: slot.rank(k + 1),
      type: 'subtask',
      title: st,
      description: null,
      assigneeId: null,
      parentId: id,
      labels: [],
    });
    stmts.push(...sub.stmts);
    notes.push(...sub.notices);
  });
  stmts.push(
    ...noticeStmts(notes),
    {
      sql: 'INSERT INTO recurring_occurrences (id, rule_id, occurs_on, issue_id, issue_key, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      params: [uuid(), rule.id, date, id, key, t],
    },
    { sql: 'UPDATE recurring_rules SET created_count = created_count + 1, last_created_on = ? WHERE id = ?', params: [date, rule.id] },
  );
  try {
    await db.batch(stmts);
  } catch (e) {
    // another run made this date first (UNIQUE rule_id, occurs_on): nothing was written
    if (/unique|duplicate/i.test(String(e?.message || e))) return { skipped: 'already created' };
    throw e;
  }
  return {
    key,
    subtasks: subtasks.length,
    created: { issueId: id, projectId: project.id, assigneeId, description, notices: main.notices, actor },
  };
}

/**
 * Announce the issue a rule created like any other new issue: Slack, the issue.created webhook and email, as the
 * person the issue was created as. Waits for the deliveries, so they count against the job's budget and finish
 * with the slice. Only the issue itself is announced: its sub-tasks stay silent, which keeps a rule with many
 * sub-tasks inside the query budget of one slice. A failed announcement never fails the job.
 */
export async function announceOccurrence(ctx, created) {
  try {
    const c = detachedContext(ctx.env, created.actor, ctx.origin);
    // as in a normal create: no Slack message or email for a mention of a guest who cannot see the project
    const ids = mentionedIds(created.description);
    const mentioned = ids.length ? await reachable(ctx.db, created.projectId, ids) : [];
    const blocked = new Set(ids.filter((m) => !mentioned.includes(m)));
    announceCreated(c, { ...created, mentioned, notices: created.notices.filter((n) => !blocked.has(n.userId)) });
    await Promise.all(c.pending);
  } catch (e) {
    console.error('recurring: could not announce', e);
  }
}

/** The `recurring` job: run(ctx, counts, room) for runJob in server/lib/jobs.js. */
export async function runRecurring(ctx, counts, room) {
  const { db } = ctx;
  const today = ctx.period;
  const t = new Date(ctx.nowMs).toISOString();
  counts.created = counts.created || 0;
  counts.skipped = counts.skipped || 0;
  const cache = {};
  let after = '';
  let madeHere = 0;
  const finish = (status) => {
    counts.summary = `${counts.created} ${counts.created === 1 ? 'issue' : 'issues'} created${counts.skipped ? `, ${counts.skipped} skipped` : ''}`;
    return { status };
  };
  for (;;) {
    if (!room() && madeHere) return finish('partial');
    const rules = await db.all(
      `${RULE_JOB_SELECT} WHERE r.paused = 0 AND p.archived = 0 AND r.start_date <= ? AND (r.end_date IS NULL OR r.end_date >= ?)
         AND (r.max_count IS NULL OR r.created_count < r.max_count) AND r.id > ? ORDER BY r.id LIMIT ?`,
      [today, addDays(today, -CATCH_UP_DAYS), after, ctx.lim.batch],
    );
    if (!rules.length) break;
    const ids = rules.map((r) => r.id);
    const done = await db.all(
      `SELECT rule_id, occurs_on FROM recurring_occurrences WHERE occurs_on >= ? AND rule_id IN (${placeholders(ids.length)})`,
      [addDays(today, -CATCH_UP_DAYS), ...ids],
    );
    const existing = new Map(ids.map((x) => [x, new Set()]));
    for (const o of done) existing.get(o.rule_id).add(o.occurs_on);
    for (const rule of rules) {
      for (const date of dueDates(rule, today, ctx.tz, existing.get(rule.id))) {
        if (!room() && madeHere) return finish('partial');
        const r = await createOccurrence(db, rule, date, t, cache);
        if (r.key) {
          await announceOccurrence(ctx, r.created);
          madeHere += 1; // a slice always creates at least one before it stops
          counts.created += 1;
          rule.created_count = Number(rule.created_count) + 1;
        } else counts.skipped += 1;
      }
      after = rule.id;
    }
    if (rules.length < ctx.lim.batch) break;
  }
  return finish('done');
}
