// The custom report engine: checking a report definition (source, kind, options) and working it out as the caller.
// Every query goes through issueFilter (lib/issues/search.js), so project visibility and API token project scope are
// the same as in issue search. Routes, saved reports and dashboards: server/routes/customReports.js.
//
// Portable SQL (SQLite/D1 and Postgres): GROUP BY on plain columns, date bucketing in JS, and one to
// three queries per report (D1 allows about 50 queries per request on the free plan).
import { fail, str } from './http.js';
import { now } from './crypto.js';
import { DAY } from './time.js';
import { TYPES, PRIORITIES, STATUS_CATEGORIES } from './issues/model.js';
import { issueFilter, searchIssues } from './issues/search.js';
import { visibleProjectsSql, ownedVisibleSql } from './access.js';
import { copyFieldQuery, visibleField, GROUPABLE_TYPES, FIELD_ID_RE } from './customFields.js';
import { parseList, parseObject } from './json.js';

const MAX_GROUPS = 25;
const MAX_COLUMNS = 10;
const MAX_DAYS = 730;
const MAX_DAILY_DAYS = 180;
const MAX_AGE_ROWS = 20000;

export const KINDS = ['breakdown', 'twoD', 'createdVsResolved', 'averageAge', 'workload', 'list'];
export const METRICS = ['count', 'storyPoints', 'estimateHours', 'loggedHours'];
const PERIODS = ['day', 'week', 'month'];
const LIST_COLUMNS = [
  'key',
  'title',
  'type',
  'status',
  'priority',
  'assignee',
  'reporter',
  'project',
  'sprint',
  'points',
  'estimate',
  'created',
  'updated',
  'due',
  'resolved',
];
const LIST_SORTS = ['created', 'updated', 'due', 'priority', 'key', 'status', 'rank', 'title'];
// issue search parameters a report source may hold (see issueFilter); the *WithinDays ones are
// relative and turned into dates each time the report runs
const QUERY_KEYS = [
  'project',
  'status',
  'statusName',
  'category',
  'type',
  'priority',
  'assignee',
  'reporter',
  'label',
  'sprint',
  'parent',
  'q',
  'updatedSince',
  'dueBefore',
  'watching',
  'noSubtasks',
  'blocked',
  'dueWithinDays',
  'updatedWithinDays',
  'component',
  'fixVersion',
];

const LABELS = {
  statusCategory: { todo: 'To do', in_progress: 'In progress', done: 'Done' },
  type: { epic: 'Epic', story: 'Story', task: 'Task', bug: 'Bug', subtask: 'Sub-task' },
  priority: { highest: 'Highest', high: 'High', medium: 'Medium', low: 'Low', lowest: 'Lowest' },
  dueBucket: { overdue: 'Overdue', week: 'Due in 7 days', later: 'Due later', none: 'No due date' },
};
// fields with a natural order keep it in charts; the rest sort by size
export const ORDER = {
  statusCategory: STATUS_CATEGORIES,
  type: TYPES,
  priority: PRIORITIES,
  dueBucket: ['overdue', 'week', 'later', 'none'],
};

const dayStr = (t) => new Date(t).toISOString().slice(0, 10);
const round1 = (n) => Math.round(Number(n || 0) * 10) / 10;

/**
 * Fields a report can group by. cols: [sql expression, alias] (alias gets a prefix so two fields can
 * share a query); join: extra JOIN for the field; group(row) -> { key, label, filter }, where filter
 * is the issue search params that narrow the list to that group (null when search cannot express it).
 */
const FIELDS = {
  status: {
    label: 'Status',
    cols: [
      ['s.name', 'name'],
      ['s.category', 'cat'],
    ],
    group: (r) => ({ key: `s:${String(r.name).toLowerCase()}`, label: r.name, category: r.cat, filter: { statusName: r.name } }),
  },
  statusCategory: {
    label: 'Status category',
    cols: [['s.category', 'v']],
    group: (r) => ({ key: r.v, label: LABELS.statusCategory[r.v] || r.v, category: r.v, filter: { category: r.v } }),
  },
  assignee: {
    label: 'Assignee',
    cols: [
      ['i.assignee_id', 'id'],
      ['a.name', 'name'],
    ],
    group: (r) =>
      r.id
        ? { key: r.id, label: r.name, filter: { assignee: r.id } }
        : { key: 'none', label: 'Unassigned', filter: { assignee: 'unassigned' } },
  },
  reporter: {
    label: 'Reporter',
    cols: [
      ['i.reporter_id', 'id'],
      ['r.name', 'name'],
    ],
    group: (r) =>
      r.id
        ? { key: r.id, label: r.name, filter: { reporter: r.id } }
        : { key: 'none', label: 'No reporter', filter: { reporter: 'unassigned' } },
  },
  type: {
    label: 'Type',
    cols: [['i.type', 'v']],
    group: (r) => ({ key: r.v, label: LABELS.type[r.v] || r.v, filter: { type: r.v } }),
  },
  priority: {
    label: 'Priority',
    cols: [['i.priority', 'v']],
    group: (r) => ({ key: r.v, label: LABELS.priority[r.v] || r.v, filter: { priority: r.v } }),
  },
  label: {
    label: 'Label',
    join: (t) => `LEFT JOIN issue_labels ${t} ON ${t}.issue_id = i.id`,
    cols: (t) => [[`${t}.label`, 'v']],
    group: (r) => (r.v ? { key: `l:${r.v}`, label: r.v, filter: { label: r.v } } : { key: 'none', label: 'No label', filter: null }),
  },
  epic: {
    label: 'Epic',
    cols: [
      ['pi.key', 'k'],
      ['pi.title', 't'],
      ['pi.type', 'ty'],
    ],
    group: (r) =>
      r.k && r.ty === 'epic'
        ? { key: r.k, label: `${r.k} ${r.t}`, filter: { parent: r.k } }
        : { key: 'none', label: 'No epic', filter: null },
  },
  sprint: {
    label: 'Sprint',
    cols: [
      ['i.sprint_id', 'id'],
      ['sp.name', 'name'],
    ],
    group: (r) =>
      r.id ? { key: r.id, label: r.name, filter: { sprint: r.id } } : { key: 'none', label: 'Backlog', filter: { sprint: 'backlog' } },
  },
  project: {
    label: 'Project',
    cols: [
      ['p.key', 'k'],
      ['p.name', 'n'],
    ],
    group: (r) => ({ key: r.k, label: `${r.n} (${r.k})`, filter: { project: r.k } }),
  },
  // components and fix versions: an issue with two counts under both (like labels)
  component: {
    label: 'Component',
    join: (t) => `LEFT JOIN issue_components ${t} ON ${t}.issue_id = i.id LEFT JOIN components ${t}c ON ${t}c.id = ${t}.component_id`,
    cols: (t) => [
      [`${t}c.id`, 'id'],
      [`${t}c.name`, 'name'],
    ],
    group: (r) =>
      r.id
        ? { key: `c:${r.id}`, label: r.name, filter: { component: r.id } }
        : { key: 'none', label: 'No component', filter: { component: 'none' } },
  },
  fixVersion: {
    label: 'Fix version',
    join: (t) => `LEFT JOIN issue_releases ${t} ON ${t}.issue_id = i.id LEFT JOIN releases ${t}r ON ${t}r.id = ${t}.release_id`,
    cols: (t) => [
      [`${t}r.id`, 'id'],
      [`${t}r.name`, 'name'],
    ],
    group: (r) =>
      r.id
        ? { key: `v:${r.id}`, label: r.name, filter: { fixVersion: r.id } }
        : { key: 'none', label: 'No fix version', filter: { fixVersion: 'none' } },
  },
  dueBucket: {
    label: 'Due date',
    cols: [['i.due_date', 'd']],
    group: (r, ctx) => {
      const b = !r.d ? 'none' : r.d < ctx.today ? 'overdue' : r.d <= ctx.weekEnd ? 'week' : 'later';
      return { key: b, label: LABELS.dueBucket[b], filter: b === 'overdue' ? { dueBefore: ctx.yesterday } : null };
    },
  },
};
export const GROUP_FIELDS = Object.keys(FIELDS);

// Custom fields as group-by fields: 'cf:<fieldId>' (select, multi-select, user, checkbox). The definition is made per
// report run from the field (customFieldDef), after checking the caller can see the field's project.
const isCustomField = (v) => typeof v === 'string' && v.startsWith('cf:') && FIELD_ID_RE.test(v.slice(3));
function pickGroupField(v, name) {
  if (isCustomField(v)) return v;
  return pick(v, GROUP_FIELDS, undefined, name);
}
const fieldOf = (name, extra) => FIELDS[name] || extra?.[name];
const asList = (g) => (Array.isArray(g) ? g : [g]);

function customFieldDef(f) {
  const id = f.id; // checked against FIELD_ID_RE, so safe in the SQL text
  const key = `cf.${id}`;
  const none = { key: 'none', label: 'No value', filter: { [`${key}.empty`]: '1' } };
  const option = (oid) => f.options.find((o) => o.id === oid);
  return {
    label: f.name,
    join: (t) =>
      `LEFT JOIN issue_field_values ${t} ON ${t}.issue_id = i.id AND ${t}.field_id = '${id}'${f.type === 'user' ? ` LEFT JOIN users ${t}u ON ${t}u.id = ${t}.value` : ''}`,
    cols: (t) => [[`${t}.value`, 'v'], ...(f.type === 'user' ? [[`${t}u.name`, 'n']] : [])],
    group: (r) => {
      if (r.v === null || r.v === undefined) return none;
      if (f.type === 'checkbox') return { key: r.v === '1' ? 'yes' : 'no', label: r.v === '1' ? 'Yes' : 'No', filter: { [key]: r.v } };
      if (f.type === 'user') return { key: `u:${r.v}`, label: r.n || 'Former user', filter: { [key]: r.v } };
      if (f.type === 'select') return { key: `o:${r.v}`, label: option(r.v)?.name || 'Removed option', filter: { [key]: r.v } };
      const list = parseList(r.v).map((oid) => ({ key: `o:${oid}`, label: option(oid)?.name || 'Removed option', filter: { [key]: oid } }));
      return list.length ? list : none;
    },
  };
}

/** Definitions of the custom fields a report groups by, as the caller can see them. */
async function customFieldDefs(db, user, options) {
  const names = [options.groupBy, options.rows, options.columns].filter(isCustomField);
  if (!names.length) return {};
  const out = {};
  const v = visibleProjectsSql(user);
  for (const name of new Set(names)) {
    const f = await visibleField(db, v, name.slice(3));
    if (!f || f.archived) fail(400, 'A custom field this report groups by was not found');
    if (!GROUPABLE_TYPES.includes(f.type))
      fail(400, `${f.name} cannot be used to group: pick a select, multi-select, user or checkbox field`);
    out[name] = customFieldDef(f);
  }
  return out;
}

const METRIC_SQL = {
  count: 'CAST(COUNT(*) AS INTEGER)',
  storyPoints: 'CAST(SUM(COALESCE(i.story_points, 0)) AS DOUBLE PRECISION)',
  estimateHours: 'CAST(SUM(COALESCE(i.estimate_hours, 0)) AS DOUBLE PRECISION)',
  loggedHours: 'CAST(SUM(COALESCE(wl.hours, 0)) AS DOUBLE PRECISION)',
};
const WORKLOG_JOIN = 'LEFT JOIN (SELECT issue_id, SUM(hours) AS hours FROM worklogs GROUP BY issue_id) wl ON wl.issue_id = i.id';

const bool = (v) => v === true || v === 'true' || v === 1 || v === '1';
function intIn(v, def, min, max, name) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(400, `${name} must be a whole number from ${min} to ${max}`);
  return n;
}
export function pick(v, list, def, name) {
  if (v === undefined || v === null || v === '') {
    if (def === undefined) fail(400, `${name} is required`);
    return def;
  }
  if (!list.includes(v)) fail(400, `${name} must be one of: ${list.join(', ')}`);
  return v;
}

/** Keep only issue search parameters, as short strings. */
export function cleanQuery(q) {
  if (q === undefined || q === null) return {};
  if (typeof q !== 'object' || Array.isArray(q)) fail(400, 'query must be an object of issue search fields');
  const out = {};
  for (const k of QUERY_KEYS) {
    const v = q[k];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') fail(400, `query.${k} must be text`);
    const s = String(v).trim();
    if (s.length > 500) fail(400, `query.${k} is too long`);
    if (s) out[k] = s;
  }
  copyFieldQuery(q, out); // cf.<fieldId> filters
  for (const k of ['dueWithinDays', 'updatedWithinDays']) if (out[k] !== undefined) intIn(out[k], 0, -3650, 3650, `query.${k}`);
  return out;
}

/** Turn relative parameters into dates, as of now. */
function resolveQuery(q) {
  const out = { ...q };
  if (out.dueWithinDays !== undefined) {
    out.dueBefore = dayStr(Date.now() + Number(out.dueWithinDays) * DAY);
    delete out.dueWithinDays;
  }
  if (out.updatedWithinDays !== undefined) {
    out.updatedSince = new Date(Date.now() - Number(out.updatedWithinDays) * DAY).toISOString();
    delete out.updatedWithinDays;
  }
  return out;
}

export function cleanSource(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) fail(400, 'source is required: {filterId} or {query}');
  if (s.filterId !== undefined && s.filterId !== null && s.filterId !== '')
    return { filterId: str(String(s.filterId), { max: 64, name: 'filterId' }) };
  return { query: cleanQuery(s.query) };
}

/** Validate and fill in the options of a report kind. Unknown options are dropped. */
export function cleanOptions(kind, o = {}) {
  pick(kind, KINDS, undefined, 'kind');
  if (o === null || typeof o !== 'object' || Array.isArray(o)) fail(400, 'options must be an object');
  switch (kind) {
    case 'breakdown':
      return {
        groupBy: pickGroupField(o.groupBy, 'groupBy'),
        metric: pick(o.metric, METRICS, 'count', 'metric'),
        chart: pick(o.chart, ['pie', 'bar', 'table'], 'pie', 'chart'),
      };
    case 'twoD': {
      const rows = pickGroupField(o.rows, 'rows');
      const columns = pickGroupField(o.columns, 'columns');
      if (rows === columns) fail(400, 'Pick two different fields for rows and columns');
      return { rows, columns, metric: pick(o.metric, METRICS, 'count', 'metric') };
    }
    case 'createdVsResolved':
    case 'averageAge': {
      const period = pick(o.period, PERIODS, kind === 'averageAge' ? 'week' : 'day', 'period');
      const days = intIn(o.days, kind === 'averageAge' ? 90 : 30, 1, MAX_DAYS, 'days');
      if (period === 'day' && days > MAX_DAILY_DAYS)
        fail(400, `Daily periods cover at most ${MAX_DAILY_DAYS} days. Pick weekly or monthly for longer ranges.`);
      return kind === 'averageAge'
        ? { period, days }
        : { period, days, cumulative: bool(o.cumulative), chart: pick(o.chart, ['line', 'bar'], 'line', 'chart') };
    }
    case 'workload':
      return { includeDone: bool(o.includeDone) };
    case 'list': {
      let columns = o.columns === undefined ? ['key', 'title', 'status', 'assignee', 'updated'] : o.columns;
      if (!Array.isArray(columns) || !columns.length) fail(400, 'columns must be a list');
      columns = [...new Set(columns)];
      for (const col of columns) pick(col, LIST_COLUMNS, undefined, 'column');
      return {
        sort: pick(o.sort, LIST_SORTS, 'created', 'sort'),
        dir: pick(o.dir, ['asc', 'desc'], 'desc', 'dir'),
        limit: intIn(o.limit, 10, 1, 100, 'limit'),
        columns,
      };
    }
    default:
      return {};
  }
}

/** The issue search params a source stands for, checked against what the caller can see. */
async function sourceQuery(db, user, source) {
  if (source.filterId) {
    const v = ownedVisibleSql(user, { shared: 'flag' });
    const f = await db.get(`SELECT query FROM saved_filters WHERE id = ? AND ${v.sql}`, [source.filterId, ...v.params]);
    if (!f) fail(404, 'The saved filter behind this report was deleted or is not shared with you');
    return cleanQuery(parseObject(f.query)); // a bad row: no conditions
  }
  return source.query || {};
}

function fieldSql(name, prefix, extra) {
  const f = fieldOf(name, extra);
  const t = `${prefix}lbl`;
  const cols = (typeof f.cols === 'function' ? f.cols(t) : f.cols).map(([expr, as]) => ({ expr, as: `${prefix}${as}` }));
  return { def: f, cols, join: f.join ? f.join(t) : '' };
}
function rowFor(row, prefix) {
  const out = {};
  for (const k of Object.keys(row)) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = row[k];
  return out;
}
function dateCtx() {
  const t = Date.now();
  return { today: dayStr(t), weekEnd: dayStr(t + 6 * DAY), yesterday: dayStr(t - DAY) };
}

/** Merge rows that map to the same group, then keep the biggest MAX groups and fold the rest into Other. */
function capGroups(groups, field, max) {
  const order = ORDER[field];
  const sorted = [...groups].sort((a, b) => b.value - a.value || b.count - a.count || String(a.label).localeCompare(String(b.label)));
  let kept = sorted;
  let other = null;
  if (sorted.length > max) {
    kept = sorted.slice(0, max);
    const rest = sorted.slice(max);
    other = {
      key: '__other',
      label: `Other (${rest.length})`,
      value: rest.reduce((s, g) => s + g.value, 0),
      count: rest.reduce((s, g) => s + g.count, 0),
      filter: null,
      other: true,
    };
  }
  if (order) kept.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  return other ? [...kept, other] : kept;
}

async function groupedRows(db, user, query, fields, metric, extraWhere = '', extra = {}) {
  const f = issueFilter(user, query);
  const parts = fields.map(([name, prefix]) => fieldSql(name, prefix, extra));
  const cols = parts.flatMap((p) => p.cols);
  const joins = parts.map((p) => p.join).filter(Boolean);
  if (metric === 'loggedHours') joins.push(WORKLOG_JOIN);
  const sql = `SELECT ${cols.map((c) => `${c.expr} AS ${c.as}`).join(', ')}, CAST(COUNT(*) AS INTEGER) AS n, ${METRIC_SQL[metric]} AS v
    ${f.from} ${joins.join(' ')} WHERE ${f.where}${extraWhere} GROUP BY ${cols.map((c) => c.expr).join(', ')}`;
  return { rows: await db.all(sql, f.params), parts };
}

async function issueCount(db, user, query) {
  const f = issueFilter(user, query);
  return (await db.get(`SELECT CAST(COUNT(*) AS INTEGER) AS n ${f.from} WHERE ${f.where}`, f.params)).n;
}

function mergeInto(map, g, count, value) {
  const cur = map.get(g.key);
  if (cur) {
    cur.count += count;
    cur.value += value;
  } else map.set(g.key, { ...g, count, value });
}

async function breakdown(db, user, query, o, extra) {
  const ctx = dateCtx();
  const { rows, parts } = await groupedRows(db, user, query, [[o.groupBy, 'g_']], o.metric, '', extra);
  const map = new Map();
  for (const r of rows) for (const g of asList(parts[0].def.group(rowFor(r, 'g_'), ctx))) mergeInto(map, g, Number(r.n), Number(r.v) || 0);
  const groups = capGroups([...map.values()], o.groupBy, MAX_GROUPS).map((g) => ({ ...g, value: round1(g.value) }));
  // a label grouping counts an issue once per label, so count the issues themselves too
  const multi =
    ['label', 'component', 'fixVersion'].includes(o.groupBy) || rows.some((r) => Array.isArray(parts[0].def.group(rowFor(r, 'g_'), ctx))); // multi-select too
  const issues = multi ? await issueCount(db, user, query) : groups.reduce((s, g) => s + g.count, 0);
  return {
    groupBy: o.groupBy,
    groupLabel: fieldOf(o.groupBy, extra).label,
    metric: o.metric,
    chart: o.chart,
    total: round1(groups.reduce((s, g) => s + g.value, 0)),
    issues,
    groups,
  };
}

async function twoD(db, user, query, o, extra) {
  const ctx = dateCtx();
  const { rows, parts } = await groupedRows(
    db,
    user,
    query,
    [
      [o.rows, 'r_'],
      [o.columns, 'c_'],
    ],
    o.metric,
    '',
    extra,
  );
  const cells = new Map(); // "rowKey\u0000colKey" -> value
  const rowMap = new Map();
  const colMap = new Map();
  for (const r of rows) {
    const rgs = asList(parts[0].def.group(rowFor(r, 'r_'), ctx)); // a multi-select field gives one group per option
    const cgs = asList(parts[1].def.group(rowFor(r, 'c_'), ctx));
    const v = Number(r.v) || 0;
    for (const rg of rgs) mergeInto(rowMap, rg, Number(r.n), v);
    for (const cg of cgs) mergeInto(colMap, cg, Number(r.n), v);
    for (const rg of rgs) {
      for (const cg of cgs) {
        const k = `${rg.key}\u0000${cg.key}`;
        cells.set(k, (cells.get(k) || 0) + v);
      }
    }
  }
  const rowGroups = capGroups([...rowMap.values()], o.rows, MAX_GROUPS);
  const colGroups = capGroups([...colMap.values()], o.columns, MAX_COLUMNS);
  const keptRows = new Set(rowGroups.filter((g) => !g.other).map((g) => g.key));
  const keptCols = new Set(colGroups.filter((g) => !g.other).map((g) => g.key));
  const ri = (k) => (keptRows.has(k) ? rowGroups.findIndex((g) => g.key === k) : rowGroups.length - 1);
  const ci = (k) => (keptCols.has(k) ? colGroups.findIndex((g) => g.key === k) : colGroups.length - 1);
  const matrix = rowGroups.map(() => colGroups.map(() => 0));
  for (const [k, v] of cells) {
    const [rk, ck] = k.split('\u0000');
    matrix[ri(rk)][ci(ck)] += v;
  }
  const strip = (g) => ({ key: g.key, label: g.label, filter: g.filter, other: Boolean(g.other), total: round1(g.value) });
  return {
    rowsField: o.rows,
    rowsLabel: fieldOf(o.rows, extra).label,
    columnsField: o.columns,
    columnsLabel: fieldOf(o.columns, extra).label,
    metric: o.metric,
    rows: rowGroups.map(strip),
    columns: colGroups.map(strip),
    cells: matrix.map((r) => r.map(round1)),
    total: round1(rowGroups.reduce((s, g) => s + g.value, 0)),
  };
}

/** Period starts (UTC) from the start of the range to now. */
function periods(period, days) {
  const nowMs = Date.now();
  let t = Math.floor((nowMs - (days - 1) * DAY) / DAY) * DAY;
  const start = (x) => {
    if (period === 'week') return x - ((new Date(x).getUTCDay() + 6) % 7) * DAY;
    if (period === 'month') {
      const d = new Date(x);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    }
    return x;
  };
  const next = (x) => {
    if (period === 'week') return x + 7 * DAY;
    if (period === 'month') {
      const d = new Date(x);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    }
    return x + DAY;
  };
  t = start(t);
  const out = [];
  while (t <= nowMs) {
    out.push({ start: t, end: next(t) });
    t = next(t);
  }
  return out;
}
const bucketIndex = (list, t) => {
  for (let i = list.length - 1; i >= 0; i--) if (t >= list[i].start) return t < list[i].end ? i : -1;
  return -1;
};

async function createdVsResolved(db, user, query, o) {
  const list = periods(o.period, o.days);
  const from = new Date(list[0].start).toISOString();
  const f = issueFilter(user, query);
  const [created, resolved] = await Promise.all([
    db.all(
      `SELECT SUBSTR(i.created_at, 1, 10) AS d, CAST(COUNT(*) AS INTEGER) AS n ${f.from} WHERE ${f.where} AND i.created_at >= ? GROUP BY SUBSTR(i.created_at, 1, 10)`,
      [...f.params, from],
    ),
    db.all(
      `SELECT SUBSTR(i.resolved_at, 1, 10) AS d, CAST(COUNT(*) AS INTEGER) AS n ${f.from} WHERE ${f.where} AND i.resolved_at IS NOT NULL AND i.resolved_at >= ? GROUP BY SUBSTR(i.resolved_at, 1, 10)`,
      [...f.params, from],
    ),
  ]);
  const fill = (rows) => {
    const vals = list.map(() => 0);
    for (const r of rows) {
      const i = bucketIndex(list, Date.parse(`${r.d}T00:00:00.000Z`));
      if (i >= 0) vals[i] += Number(r.n);
    }
    return vals;
  };
  let c = fill(created);
  let r = fill(resolved);
  const totals = { created: c.reduce((a, b) => a + b, 0), resolved: r.reduce((a, b) => a + b, 0) };
  if (o.cumulative) {
    const run = (vals) => {
      let s = 0;
      return vals.map((v) => (s += v));
    };
    c = run(c);
    r = run(r);
  }
  return {
    period: o.period,
    days: o.days,
    cumulative: o.cumulative,
    chart: o.chart,
    periods: list.map((p) => dayStr(p.start)),
    created: c,
    resolved: r,
    totals,
  };
}

async function averageAge(db, user, query, o) {
  const list = periods(o.period, o.days);
  const nowMs = Date.now();
  const f = issueFilter(user, query);
  const rows = await db.all(
    `SELECT i.created_at, i.resolved_at ${f.from} WHERE ${f.where} AND (i.resolved_at IS NULL OR i.resolved_at >= ?) LIMIT ?`,
    [...f.params, new Date(list[0].start).toISOString(), MAX_AGE_ROWS + 1],
  );
  const truncated = rows.length > MAX_AGE_ROWS;
  const issues = rows
    .slice(0, MAX_AGE_ROWS)
    .map((x) => ({ c: Date.parse(x.created_at), r: x.resolved_at ? Date.parse(x.resolved_at) : null }));
  const points = list.map((p) => {
    const at = Math.min(p.end, nowMs); // age at the end of the period (now for the current one)
    let n = 0;
    let sum = 0;
    for (const x of issues) {
      if (x.c < at && (x.r === null || x.r >= at)) {
        n++;
        sum += (at - x.c) / DAY;
      }
    }
    return { start: dayStr(p.start), open: n, averageDays: n ? round1(sum / n) : null };
  });
  return { period: o.period, days: o.days, points, truncated };
}

async function workload(db, user, query, o) {
  const f = issueFilter(user, query);
  const rows = await db.all(
    `SELECT i.assignee_id AS id, a.name AS name, CAST(COUNT(*) AS INTEGER) AS n,
       CAST(SUM(COALESCE(i.story_points, 0)) AS DOUBLE PRECISION) AS pts,
       CAST(SUM(COALESCE(i.estimate_hours, 0)) AS DOUBLE PRECISION) AS est,
       CAST(SUM(COALESCE(wl.hours, 0)) AS DOUBLE PRECISION) AS logged
     ${f.from} ${WORKLOG_JOIN} WHERE ${f.where}${o.includeDone ? '' : ` AND s.category <> 'done'`}
     GROUP BY i.assignee_id, a.name`,
    f.params,
  );
  const extra = o.includeDone ? {} : { category: 'todo,in_progress' };
  let people = rows
    .map((r) => ({
      id: r.id || null,
      name: r.id ? r.name : 'Unassigned',
      issues: Number(r.n),
      points: round1(r.pts),
      estimateHours: round1(r.est),
      loggedHours: round1(r.logged),
      filter: { assignee: r.id || 'unassigned', ...extra },
    }))
    .sort((a, b) => b.issues - a.issues || b.points - a.points || a.name.localeCompare(b.name));
  if (people.length > MAX_GROUPS) {
    const rest = people.slice(MAX_GROUPS);
    const sum = (k) => round1(rest.reduce((s, p) => s + p[k], 0));
    people = [
      ...people.slice(0, MAX_GROUPS),
      {
        id: null,
        name: `Other (${rest.length})`,
        other: true,
        issues: sum('issues'),
        points: sum('points'),
        estimateHours: sum('estimateHours'),
        loggedHours: sum('loggedHours'),
        filter: null,
      },
    ];
  }
  const total = (k) => round1(people.reduce((s, p) => s + p[k], 0));
  return {
    includeDone: o.includeDone,
    people,
    totals: { issues: total('issues'), points: total('points'), estimateHours: total('estimateHours'), loggedHours: total('loggedHours') },
  };
}

async function issueList(db, user, query, o) {
  const r = await searchIssues(db, user, { ...query, sort: o.sort, dir: o.dir, limit: o.limit });
  const issues = r.issues.map((i) => ({
    key: i.key,
    title: i.title,
    type: i.type,
    status: i.status,
    priority: i.priority,
    assignee: i.assignee
      ? { id: i.assignee.id, name: i.assignee.name, avatarColor: i.assignee.avatarColor, avatarUrl: i.assignee.avatarUrl }
      : null,
    reporter: i.reporter ? { id: i.reporter.id, name: i.reporter.name } : null,
    project: { key: i.projectKey, name: i.projectName },
    sprint: i.sprint,
    points: i.storyPoints,
    estimate: i.estimateHours,
    created: i.createdAt,
    updated: i.updatedAt,
    due: i.dueDate,
    resolved: i.resolvedAt,
  }));
  return { columns: o.columns, sort: o.sort, dir: o.dir, total: r.total, issues };
}

const RUNNERS = { breakdown, twoD, createdVsResolved, averageAge, workload, list: issueList };

/** Work out a report as `user`. source and options must already be cleaned. */
export async function runReport(db, user, { source, kind, options }) {
  const saved = await sourceQuery(db, user, source);
  const query = resolveQuery(saved);
  const extra = kind === 'breakdown' || kind === 'twoD' ? await customFieldDefs(db, user, options) : {};
  const data = await RUNNERS[kind](db, user, query, options, extra);
  return { kind, options, query, ...data, generatedAt: now() };
}
