// RAID log in the browser: colours, the list's sorts and filter, history sentences. The rules themselves (types,
// statuses, overdue, score bands, history fields) are shared with the server in shared/raid.js.
import { RAID_TYPES as TYPE_IDS, TYPE_LABELS, STATUS_LABELS, HISTORY_FIELDS, LONG_FIELDS, isOverdue, scoreBand } from '../shared/raid.js';

export { STATUS_LABELS, ITEM_STATUSES, DECISION_STATUSES, statusesFor, isOverdue } from '../shared/raid.js';

const TYPE_LOOK = {
  risk: { plural: 'Risks', cls: 'bg-red-50 text-red-900 border border-red-200' },
  assumption: { plural: 'Assumptions', cls: 'bg-sky-50 text-sky-900 border border-sky-200' },
  issue: { plural: 'Issues', cls: 'bg-amber-50 text-amber-900 border border-amber-200' },
  decision: { plural: 'Decisions', cls: 'bg-violet-50 text-violet-900 border border-violet-200' },
};
export const RAID_TYPES = TYPE_IDS.map((id) => ({ id, label: TYPE_LABELS[id], ...TYPE_LOOK[id] }));
export const typeOf = (id) => RAID_TYPES.find((t) => t.id === id) || RAID_TYPES[0];
export const statusCls = (s) =>
  s === 'closed' || s === 'superseded'
    ? 'bg-slate-100 text-slate-700'
    : s === 'agreed'
      ? 'bg-green-100 text-green-900'
      : s === 'monitoring'
        ? 'bg-sky-100 text-sky-900'
        : 'bg-white text-slate-800 border border-slate-300';
export const LEVELS = ['Very low', 'Low', 'Medium', 'High', 'Very high'];

/** Score band: high (12 or more), medium (5 to 11), low (1 to 4). Always shown with its word, never colour alone. */
const BANDS = {
  high: { label: 'High', cls: 'bg-red-100 text-red-900 border-red-700' },
  medium: { label: 'Medium', cls: 'bg-amber-100 text-amber-900 border-amber-700' },
  low: { label: 'Low', cls: 'bg-green-100 text-green-900 border-green-700' },
};
export const band = (score) => BANDS[scoreBand(score)] || null;

// ---- the list (views/project/RaidView.vue) ----
export const SORTS = [
  { id: 'score', label: 'Risk score', cmp: (a, b) => (b.score ?? -1) - (a.score ?? -1) },
  { id: 'review', label: 'Review date', cmp: (a, b) => (a.reviewDate || '9999').localeCompare(b.reviewDate || '9999') },
  { id: 'updated', label: 'Last updated', cmp: (a, b) => b.updatedAt.localeCompare(a.updatedAt) },
  { id: 'created', label: 'Newest', cmp: (a, b) => b.createdAt.localeCompare(a.createdAt) },
  { id: 'ref', label: 'Number', cmp: (a, b) => a.number - b.number },
  { id: 'title', label: 'Title', cmp: (a, b) => a.title.localeCompare(b.title) },
];

/**
 * Does the entry pass the list's filters? f: { type, status ('active' or one status), owner ('me', 'none' or a
 * user id), overdue, q, cell ({ p, i } of the heat map) }. me: the viewer's user id; today: 'YYYY-MM-DD'.
 * skipType: everything but the type filter (the type tabs count with these).
 */
export function matchesFilter(e, f, { me, today }, skipType = false) {
  if (!skipType && f.type && e.type !== f.type) return false;
  if (f.status === 'active' && !e.active) return false;
  if (f.status && f.status !== 'active' && e.status !== f.status) return false;
  if (f.owner === 'me' && e.owner?.id !== me) return false;
  if (f.owner === 'none' && e.owner) return false;
  if (f.owner && f.owner !== 'me' && f.owner !== 'none' && e.owner?.id !== f.owner) return false;
  if (f.overdue && !isOverdue(e, today)) return false;
  if (f.cell && (e.probability !== f.cell.p || e.impact !== f.cell.i)) return false;
  if (f.q) {
    const s = f.q.toLowerCase();
    if (!e.title.toLowerCase().includes(s) && e.ref.toLowerCase() !== s && !e.description.toLowerCase().includes(s)) return false;
  }
  return true;
}

/** Heat map counts of the active risks: heat[probability - 1][impact - 1]. */
export function riskHeat(entries) {
  const h = Array.from({ length: 5 }, () => Array(5).fill(0));
  for (const e of entries) if (e.type === 'risk' && e.active && e.probability && e.impact) h[e.probability - 1][e.impact - 1] += 1;
  return h;
}

// ---- an entry's history ----
/** One history line in words: "changed the status from Open to Closed". */
export function historyText(h) {
  if (h.field === 'created') return `created ${h.to || ''}`;
  const name = (HISTORY_FIELDS[h.field] || h.field).toLowerCase();
  if (LONG_FIELDS.includes(h.field)) return `changed the ${name}`;
  const show = (v) => (h.field === 'status' ? STATUS_LABELS[v] || v : v);
  return `changed the ${name} from ${h.from ? show(h.from) : 'none'} to ${h.to ? show(h.to) : 'none'}`;
}
