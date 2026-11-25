// Portfolio page helpers: filters, sorting, CSV and the shareable URL query. Pure functions (no DOM), so
// test/portfolio.test.js checks them too. Rows come from GET /api/portfolio (server/lib/portfolio.js).
import { toCsv as csvText } from './csv.js';
import { counted } from './plural.js';

export const HEALTH = {
  green: { label: 'Green', cls: 'bg-green-100 text-green-900 border-green-700', rank: 1 },
  amber: { label: 'Amber', cls: 'bg-amber-100 text-amber-900 border-amber-700', rank: 2 },
  red: { label: 'Red', cls: 'bg-red-100 text-red-900 border-red-700', rank: 3 },
};
export const healthLabel = (h) => (h?.value ? HEALTH[h.value]?.label || 'Not set' : 'Not set');
/** The health in words: "Amber, status report to 2026-11-18" or "No report, computed Green". */
export const healthText = (h) =>
  h?.source === 'report' ? `${healthLabel(h)}, status report to ${h.periodEnd}` : `No report, computed ${healthLabel(h)}`;

/** Columns: id, label, the value sorted on (nulls last), and the CSV cell. */
export const COLUMNS = [
  { id: 'name', label: 'Project', sort: (r) => r.name.toLowerCase() },
  { id: 'lead', label: 'Lead', sort: (r) => r.lead?.name?.toLowerCase() ?? null },
  {
    id: 'health',
    label: 'Health',
    sort: (r) => (r.health?.value ? HEALTH[r.health.value].rank + (r.health.source === 'computed' ? 0.5 : 0) : null),
  },
  { id: 'done', label: '% done', sort: (r) => r.done.pct },
  { id: 'open', label: 'Open', sort: (r) => r.open },
  { id: 'overdue', label: 'Overdue', sort: (r) => r.overdue },
  { id: 'blocked', label: 'Blocked', sort: (r) => r.blocked },
  { id: 'highBugs', label: 'High bugs', sort: (r) => r.highBugs },
  { id: 'milestone', label: 'Next milestone', sort: (r) => r.nextMilestone?.date ?? null },
  { id: 'sprint', label: 'Active sprint', sort: (r) => r.activeSprint?.daysLeft ?? null },
  { id: 'budget', label: 'Budget used', sort: (r) => r.budget?.usedPct ?? null, budget: true },
  { id: 'activity', label: 'Last activity', sort: (r) => r.lastActivity || null },
];
export const columnsFor = (budgetShown) => COLUMNS.filter((c) => !c.budget || budgetShown);

export const DEFAULT_FILTERS = { q: '', lead: '', health: '', mine: false, archived: false, sort: 'health', dir: 'desc' };
const HEALTH_FILTERS = ['green', 'amber', 'red', 'none'];

/** Filters from the URL query (shareable links). */
export function filtersFromQuery(q = {}) {
  const one = (v) => (Array.isArray(v) ? v[0] : v) ?? '';
  const sort = String(one(q.sort));
  return {
    q: String(one(q.q)).slice(0, 200),
    lead: String(one(q.lead)),
    health: HEALTH_FILTERS.includes(one(q.health)) ? one(q.health) : '',
    mine: one(q.mine) === '1',
    archived: one(q.archived) === '1',
    sort: COLUMNS.some((c) => c.id === sort) ? sort : DEFAULT_FILTERS.sort,
    dir: one(q.dir) === 'asc' ? 'asc' : one(q.dir) === 'desc' ? 'desc' : DEFAULT_FILTERS.dir,
  };
}

/** The URL query for these filters (defaults left out). */
export function queryFromFilters(f) {
  const out = {};
  if (f.q) out.q = f.q;
  if (f.lead) out.lead = f.lead;
  if (f.health) out.health = f.health;
  if (f.mine) out.mine = '1';
  if (f.archived) out.archived = '1';
  if (f.sort !== DEFAULT_FILTERS.sort || f.dir !== DEFAULT_FILTERS.dir) {
    out.sort = f.sort;
    out.dir = f.dir;
  }
  return out;
}

/** Rows matching the filters. health 'none' = no published report. lead 'none' = no lead. */
export function filterRows(rows, f) {
  const q = (f.q || '').trim().toLowerCase();
  return rows.filter((r) => {
    if (q && !`${r.name} ${r.key}`.toLowerCase().includes(q)) return false;
    if (f.lead && (f.lead === 'none' ? r.lead : r.lead?.id !== f.lead)) return false;
    if (f.health === 'none' && r.health.source === 'report') return false;
    if (f.health && f.health !== 'none' && !(r.health.source === 'report' && r.health.value === f.health)) return false;
    if (f.mine && !r.mine) return false;
    return true;
  });
}

/** Rows sorted on a column; empty values always last, then by name. */
export function sortRows(rows, sort, dir = 'asc') {
  const col = COLUMNS.find((c) => c.id === sort) || COLUMNS[0];
  const sign = dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = col.sort(a);
    const y = col.sort(b);
    if (x === null && y !== null) return 1;
    if (y === null && x !== null) return -1;
    if (x !== null && y !== null && x !== y) return (x < y ? -1 : 1) * sign;
    return a.name.localeCompare(b.name);
  });
}

/** Leads in the rows, for the filter: [{ id, name }] by name. */
export function leadsOf(rows) {
  const m = new Map();
  for (const r of rows) if (r.lead) m.set(r.lead.id, r.lead.name);
  return [...m].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

export const daysText = (n) =>
  n === null || n === undefined ? '' : n === 0 ? 'today' : n > 0 ? `${counted(n, 'day')} left` : `${counted(-n, 'day')} overdue`;

/** The table as CSV (one line per row, the columns shown on the page plus the counts behind them). */
export function toCsv(rows, { budgetShown = false } = {}) {
  const head = [
    'Key',
    'Project',
    'Lead',
    'Health',
    'Health source',
    'Report period end',
    'Done %',
    'Done issues',
    'Issues',
    'Done % (points)',
    'Points done',
    'Points',
    'Open',
    'Overdue',
    'Blocked',
    'High priority bugs',
    'Next milestone',
    'Milestone date',
    'Milestone days left',
    'Active sprint',
    'Sprint days left',
  ];
  if (budgetShown) head.push('Budget used %');
  head.push('Last activity', 'Archived');
  const lines = [head];
  for (const r of rows) {
    const line = [
      r.key,
      r.name,
      r.lead?.name || '',
      healthLabel(r.health),
      r.health.source,
      r.health.periodEnd || '',
      r.done.pct ?? '',
      r.done.issues,
      r.done.total,
      r.done.pointsPct ?? '',
      r.done.points,
      r.done.pointsTotal,
      r.open,
      r.overdue,
      r.blocked,
      r.highBugs,
      r.nextMilestone?.name || '',
      r.nextMilestone?.date || '',
      r.nextMilestone ? r.nextMilestone.daysLeft : '',
      r.activeSprint?.name || '',
      r.activeSprint?.daysLeft ?? '',
    ];
    if (budgetShown) line.push(r.budget?.usedPct ?? '');
    line.push((r.lastActivity || '').slice(0, 10), r.archived ? 'yes' : 'no');
    lines.push(line);
  }
  return csvText(lines);
}
