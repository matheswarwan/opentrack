// Shared definitions for the Reports page (custom reports and dashboards).
import { qs } from './api.js';
import { COLORS } from './components/charts/chart.js';

export const KINDS = [
  { id: 'breakdown', label: 'Pie or bar chart', short: 'Breakdown', description: 'Count or sum of issues grouped by one field.' },
  {
    id: 'twoD',
    label: 'Two-dimensional table',
    short: 'Two-dimensional',
    description: 'Issues counted by one field in rows and another in columns.',
  },
  {
    id: 'createdVsResolved',
    label: 'Created vs resolved',
    short: 'Created vs resolved',
    description: 'Issues created and resolved per day, week or month.',
  },
  { id: 'averageAge', label: 'Average age', short: 'Average age', description: 'Average age in days of unresolved issues over time.' },
  { id: 'workload', label: 'Workload by assignee', short: 'Workload', description: 'Open issues, story points and hours per person.' },
  { id: 'list', label: 'Issue list', short: 'Issue list', description: 'The issues themselves, for example recently created or due soon.' },
];
export const kindOf = (id) => KINDS.find((k) => k.id === id) || KINDS[0];

export const FIELDS = [
  { id: 'status', label: 'Status' },
  { id: 'statusCategory', label: 'Status category' },
  { id: 'assignee', label: 'Assignee' },
  { id: 'reporter', label: 'Reporter' },
  { id: 'type', label: 'Type' },
  { id: 'priority', label: 'Priority' },
  { id: 'label', label: 'Label' },
  { id: 'epic', label: 'Epic' },
  { id: 'sprint', label: 'Sprint' },
  { id: 'project', label: 'Project' },
  { id: 'dueBucket', label: 'Due date' },
  { id: 'component', label: 'Component' },
  { id: 'fixVersion', label: 'Fix version' },
];
export const fieldLabel = (id) => FIELDS.find((f) => f.id === id)?.label || id;

export const METRICS = [
  { id: 'count', label: 'Issue count', unit: 'issues' },
  { id: 'storyPoints', label: 'Story points', unit: 'points' },
  { id: 'estimateHours', label: 'Estimated hours', unit: 'hours' },
  { id: 'loggedHours', label: 'Logged hours', unit: 'hours' },
];
export const metricOf = (id) => METRICS.find((m) => m.id === id) || METRICS[0];

export const COLUMNS = [
  { id: 'key', label: 'Key' },
  { id: 'title', label: 'Summary' },
  { id: 'type', label: 'Type' },
  { id: 'status', label: 'Status' },
  { id: 'priority', label: 'Priority' },
  { id: 'assignee', label: 'Assignee' },
  { id: 'reporter', label: 'Reporter' },
  { id: 'project', label: 'Project' },
  { id: 'sprint', label: 'Sprint' },
  { id: 'points', label: 'Points' },
  { id: 'estimate', label: 'Estimate' },
  { id: 'created', label: 'Created' },
  { id: 'updated', label: 'Updated' },
  { id: 'due', label: 'Due' },
  { id: 'resolved', label: 'Resolved' },
];
export const SORTS = [
  { id: 'created', label: 'Created' },
  { id: 'updated', label: 'Updated' },
  { id: 'due', label: 'Due date' },
  { id: 'priority', label: 'Priority' },
  { id: 'key', label: 'Key' },
  { id: 'status', label: 'Status' },
];

/** Default options for a kind (the server fills in the same defaults). */
export function defaultOptions(kind) {
  switch (kind) {
    case 'breakdown':
      return { groupBy: 'status', metric: 'count', chart: 'pie' };
    case 'twoD':
      return { rows: 'assignee', columns: 'statusCategory', metric: 'count' };
    case 'createdVsResolved':
      return { period: 'day', days: 30, cumulative: false, chart: 'line' };
    case 'averageAge':
      return { period: 'week', days: 90 };
    case 'workload':
      return { includeDone: false };
    case 'list':
      return { sort: 'created', dir: 'desc', limit: 10, columns: ['key', 'title', 'status', 'assignee', 'updated'] };
    default:
      return {};
  }
}

// segment colours: the theme colours first, then lighter tints of them
export const PALETTE = [
  COLORS.primary,
  COLORS.secondary,
  COLORS.tertiary,
  COLORS.quaternary,
  COLORS.black,
  COLORS.lightGrey,
  '#f4a07f',
  '#7fb3bc',
  '#a9b8a3',
  '#b3dbe3',
  '#57534e',
  '#d6d0cc',
];
const CATEGORY_COLORS = { todo: COLORS.lightGrey, in_progress: COLORS.quaternary, done: COLORS.secondary };
export function groupColor(g, i) {
  if (g.other) return '#d6d0cc';
  if (g.category && CATEGORY_COLORS[g.category] && !g.key.startsWith?.('s:')) return CATEGORY_COLORS[g.category];
  return PALETTE[i % PALETTE.length];
}

/** /issues link for a report query, narrowed by a segment's filter. Query keys of the segment win. */
export function issuesLink(query, filter) {
  return `/issues?${qs({ ...(query || {}), ...(filter || {}) })}`;
}

export const fmt = (v) => (v === null || v === undefined ? '' : Number.isInteger(v) ? String(v) : Number(v).toFixed(1));
export const shortDate = (d) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
export const monthLabel = (d) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });

// ---- where a report's issues come from (step 1 of the builder, components/reports/ReportSource.vue) ----
// The fields the "Issues matching" form shows. Other query keys of a saved report are kept in extraQuery.
export const QUICK_KEYS = ['project', 'category', 'assignee', 'type', 'priority', 'label', 'sprint', 'q', 'dueWithinDays'];

/** The empty step 1 form. mode: 'filter' (a saved filter), 'project' (one project or all) or 'matching' (the quick fields). */
export const blankSourceForm = () => ({
  mode: 'matching',
  filterId: '',
  projectKey: '',
  quick: Object.fromEntries(QUICK_KEYS.map((k) => [k, ''])),
  extraQuery: {},
});

/** The report source the form stands for: { filterId } or { query }. null while no saved filter is chosen. */
export function sourceOf(form) {
  if (form.mode === 'filter') return form.filterId ? { filterId: form.filterId } : null;
  if (form.mode === 'project') return { query: form.projectKey ? { project: form.projectKey } : {} };
  const q = { ...form.extraQuery };
  for (const k of QUICK_KEYS)
    if (form.quick[k] !== '' && form.quick[k] !== null && form.quick[k] !== undefined) q[k] = String(form.quick[k]);
  return { query: q };
}

/** The form for a saved report's source (the reverse of sourceOf). A query on one project only, or none, is the Project mode. */
export function sourceFormOf(source) {
  const form = blankSourceForm();
  if (source.filterId) return { ...form, mode: 'filter', filterId: source.filterId };
  const q = source.query || {};
  if (Object.keys(q).every((k) => k === 'project') && !String(q.project || '').includes(','))
    return { ...form, mode: 'project', projectKey: q.project || '' };
  for (const [k, v] of Object.entries(q)) {
    if (QUICK_KEYS.includes(k)) form.quick[k] = v;
    else form.extraQuery[k] = v;
  }
  return form;
}

/** The one project the form covers, '' when it covers several or all (its custom fields can then be grouped on). */
export function sourceProjectOf(form) {
  const k = form.mode === 'project' ? form.projectKey : form.mode === 'matching' ? form.quick.project : '';
  return k && !String(k).includes(',') ? String(k) : '';
}
