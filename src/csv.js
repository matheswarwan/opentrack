// CSV in the web app: writing it (every export built in the browser), parsing it, and the column mapping
// for the issue import and the user import.
import { pad } from './dates.js';

export { csvCell, toCsv } from '../shared/csv.js';

/** Parse CSV or TSV text into rows of cells. Handles quoted cells with commas, quotes and line breaks. */
export function parseCsv(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const sep =
    (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length
      ? '\t'
      : (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length
        ? ';'
        : ',';
  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"' && cur === '') quoted = true;
    else if (ch === sep) {
      row.push(cur);
      cur = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
    } else cur += ch;
  }
  if (cur !== '' || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/**
 * Admin > Users > Import from CSV: the people in a pasted or uploaded list, as { email, name, role, title }.
 * With a header row that has an email column, columns are found by name (in any order); without one they
 * are read as email, name, role, title.
 */
export function parseUserRows(text) {
  const rows = parseCsv(text).map((r) => r.map((c) => c.trim()));
  if (rows.length && rows[0].some((c) => /^e-?mail$/i.test(c))) {
    const head = rows.shift().map((h) => h.toLowerCase());
    const col = (n) => head.findIndex((h) => h.replace(/[^a-z]/g, '') === n);
    const [e, n, r, t] = [col('email'), col('name'), col('role'), col('title')];
    return rows.map((c) => ({
      email: c[e],
      name: n >= 0 ? c[n] || '' : '',
      role: r >= 0 && c[r] ? c[r].toLowerCase() : 'member',
      title: t >= 0 ? c[t] || '' : '',
    }));
  }
  return rows.map((c) => ({ email: c[0], name: c[1] || '', role: (c[2] || 'member').toLowerCase(), title: c[3] || '' }));
}

/** Fields the import API takes, with the header names (ours and Jira's) that map to them. */
export const IMPORT_FIELDS = [
  { key: 'title', label: 'Title', match: /^(title|summary)$/i, required: true },
  { key: 'type', label: 'Type', match: /^(type|issue ?type)$/i },
  { key: 'description', label: 'Description', match: /^description$/i },
  { key: 'priority', label: 'Priority', match: /^priority$/i },
  { key: 'assignee', label: 'Assignee (email or name)', match: /^assignee( email)?$/i },
  { key: 'reporter', label: 'Reporter (email or name)', match: /^reporter( email)?$/i },
  { key: 'labels', label: 'Labels', match: /^labels?$/i },
  { key: 'parent', label: 'Parent (key or #row)', match: /^parent( key)?$/i },
  { key: 'status', label: 'Status', match: /^status$/i },
  { key: 'sprint', label: 'Sprint', match: /^sprint$/i },
  { key: 'components', label: 'Components (names)', match: /^(components?|component\/s)$/i },
  { key: 'fix_versions', label: 'Fix versions (names)', match: /^(fix ?versions?|fix version\/s)$/i },
  {
    key: 'story_points',
    label: 'Story points',
    match: /^(story[ _]?points|custom field \(story points\)|story point estimate|custom field \(story point estimate\))$/i,
  },
  { key: 'due_date', label: 'Due date', match: /^(due[ _]?date|due)$/i },
  { key: 'estimate_hours', label: 'Estimate (hours)', match: /^(estimate[ _]?hours|estimate)$/i },
  { key: 'estimate_seconds', label: 'Original estimate (seconds, Jira)', match: /^original estimate$/i },
];

/**
 * Import targets for a project's custom fields: key 'cf:<fieldId>'. A column matches by the field's name, or Jira's
 * "Custom field (Name)" header.
 */
export function fieldTargets(fields) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (fields || [])
    .filter((f) => !f.archived)
    .map((f) => ({
      key: `cf:${f.id}`,
      label: f.name,
      required: f.required,
      field: f,
      match: new RegExp(`^(${esc(f.name)}|custom field \\(${esc(f.name)}\\))$`, 'i'),
    }));
}

/** Guess a mapping { fieldKey: columnIndex } from the header row (and data rows, to skip Jira's numeric parent ids). */
export function guessMapping(header, data = [], extra = []) {
  const map = {};
  for (const f of [...IMPORT_FIELDS, ...extra]) {
    const i = header.findIndex((h) => f.match.test(String(h).trim()));
    map[f.key] = i;
  }
  if (map.parent >= 0 && data.some((r) => /^\d+$/.test(String(r[map.parent] || '').trim()))) map.parent = -1;
  return map;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** YYYY-MM-DD from common formats (ISO, Jira's 18/Nov/26 12:00 AM); otherwise the text as given. */
export function normDate(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const j = s.match(/^(\d{1,2})\/([A-Za-z]{3})\/(\d{2}|\d{4})/);
  if (j && MONTHS[j[2].toLowerCase()]) {
    const y = j[3].length === 2 ? 2000 + Number(j[3]) : Number(j[3]);
    return `${y}-${pad(MONTHS[j[2].toLowerCase()])}-${pad(j[1])}`;
  }
  return s;
}

const JIRA_PRIORITIES = { blocker: 'highest', critical: 'high', major: 'medium', minor: 'low', trivial: 'lowest' };

/** Turn parsed rows (first row = header) into API rows using `map`. extra: fieldTargets (values go to row.fields). */
export function mapRows(rows, map, extra = []) {
  const [header, ...data] = rows;
  const sameHeader = (i) =>
    i < 0 ? [] : header.map((h, k) => (h.trim().toLowerCase() === header[i].trim().toLowerCase() ? k : -1)).filter((k) => k >= 0);
  const labelCols = sameHeader(map.labels ?? -1); // Jira repeats the Labels column once per label
  const listCols = { components: sameHeader(map.components ?? -1), fix_versions: sameHeader(map.fix_versions ?? -1) }; // Component/s, Fix Version/s too
  return data.map((cells) => {
    const get = (key) => {
      const i = map[key];
      return i === undefined || i < 0 ? '' : String(cells[i] ?? '').trim();
    };
    const out = {};
    for (const f of IMPORT_FIELDS) {
      if (f.key === 'labels' || f.key === 'estimate_seconds' || listCols[f.key]) continue;
      const v = get(f.key);
      if (v !== '') out[f.key] = v;
    }
    if (labelCols.length) {
      const labels = labelCols.flatMap((i) => String(cells[i] ?? '').split(/[\s,]+/)).filter(Boolean);
      if (labels.length) out.labels = labels;
    }
    for (const [key, cols] of Object.entries(listCols)) {
      const names = [
        ...new Set(
          cols
            .flatMap((i) => String(cells[i] ?? '').split(','))
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ];
      if (names.length) out[key] = names;
    }
    if (out.priority && JIRA_PRIORITIES[out.priority.toLowerCase()]) out.priority = JIRA_PRIORITIES[out.priority.toLowerCase()];
    if (out.due_date) out.due_date = normDate(out.due_date);
    const secs = get('estimate_seconds');
    if (!out.estimate_hours && secs && Number.isFinite(Number(secs)))
      out.estimate_hours = String(Math.round((Number(secs) / 3600) * 100) / 100);
    for (const t of extra) {
      const v = get(t.key);
      if (v === '') continue;
      out.fields = { ...(out.fields || {}), [t.field.id]: t.field.type === 'date' ? normDate(v) : v };
    }
    return out;
  });
}

export const TEMPLATE_CSV = [
  'title,type,description,priority,assignee,reporter,labels,parent,status,sprint,story_points,due_date,estimate_hours',
  'Checkout redesign,epic,,high,,,,,,,,,',
  'New payment form,story,"Card, PayPal and invoice",medium,jane@example.com,,checkout ui,#1,To Do,,5,2026-12-15,8',
  'Fix rounding in totals,bug,,highest,,,checkout,#1,In Progress,,2,,3',
].join('\n');
