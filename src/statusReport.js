// Status reports in the browser: RAG labels and the report as Markdown (Copy as text, print page, preview).
// Pure functions (no DOM), so test/status-reports.test.js checks them too.

export const RAG = {
  green: { label: 'Green', cls: 'bg-green-100 text-green-900 border-green-700' },
  amber: { label: 'Amber', cls: 'bg-amber-100 text-amber-900 border-amber-700' },
  red: { label: 'Red', cls: 'bg-red-100 text-red-900 border-red-700' },
};
export const RAG_AREAS = [
  { id: 'overall', label: 'Overall' },
  { id: 'scope', label: 'Scope' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'quality', label: 'Quality' },
  { id: 'budget', label: 'Budget' },
];
export const SECTIONS = [
  { id: 'done', label: 'Done this period' },
  { id: 'inProgress', label: 'In progress' },
  { id: 'next', label: 'Planned next' },
  { id: 'milestones', label: 'Milestones and releases' },
  { id: 'risks', label: 'Risks and blockers' },
  { id: 'topRisks', label: 'Top risks' },
  { id: 'decisions', label: 'Decisions needed' },
  { id: 'time', label: 'Time logged this period' },
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 2026-11-18 -> 18 Nov 2026 */
export function day(d) {
  if (!d) return '';
  const [y, m, dd] = d.split('-').map(Number);
  return `${dd} ${MONTHS[m - 1]} ${y}`;
}
export const periodText = (r) => `${day(r.periodStart)} to ${day(r.periodEnd)}`;
export const ragLabel = (v) => RAG[v]?.label || 'Not set';

const esc = (s) => String(s ?? '').replace(/([\\`*_[\]<>])/g, '\\$1');

/** One issue or milestone as plain text, without the issue key. */
export function itemText(id, x) {
  if (id === 'milestones')
    return `${x.name}: ${x.status === 'released' ? 'released' : 'unreleased'}${x.date ? `, ${day(x.date)}` : ''}, ${x.done ?? 0} of ${x.total ?? 0} issues done${x.overdue ? ' (past its date)' : ''}`;
  if (id === 'decisions') return x.text || '';
  if (id === 'time') return `${x.name}: ${x.hours} h`;
  const bits = [];
  if (x.status && id !== 'done') bits.push(x.status);
  if (x.assignee && id !== 'done') bits.push(x.assignee);
  if (x.why) bits.push(x.why);
  if (x.reasons?.length) bits.push(x.reasons.join('; '));
  return `${x.title || x.text || ''}${bits.length ? ` (${bits.join(', ')})` : ''}`;
}

/** One list line in Markdown (the key stays plain so it becomes a link). */
export const itemLine = (id, x) => `${x.key ? `${x.key} ` : ''}${esc(itemText(id, x))}`;

/** Items of a section grouped for display: Done is grouped by epic, the rest is one group. */
export function groups(id, items = []) {
  if (id !== 'done') return [{ title: null, items }];
  const out = new Map();
  for (const x of items) {
    const k = x.epic?.key || '';
    if (!out.has(k)) out.set(k, { title: x.epic ? `${x.epic.key} ${x.epic.title}` : 'Other work', items: [] });
    out.get(k).items.push(x);
  }
  return [...out.values()];
}

/** Sections that show (time logged only when there are work logs and it is not hidden). */
export function visibleSections(report) {
  const s = report.sections || {};
  return SECTIONS.filter((x) => s[x.id] && !(x.id === 'time' && (s.time.hidden || !(s.time.items || []).length)));
}

/** The whole report as Markdown. opts.head = false leaves out the title, period and RAG table (pages that draw them). */
export function reportMarkdown(report, project, { head = true } = {}) {
  const out = [];
  if (head)
    out.push(
      `# Status report: ${project.name}`,
      '',
      `Period: ${periodText(report)}${report.publishedAt ? `. Published ${day(report.publishedAt.slice(0, 10))}` : '. Draft'}${report.author ? ` by ${report.author.name}` : ''}.`,
      '',
      '| Area | Status | Notes |',
      '| --- | --- | --- |',
    );
  for (const a of head ? RAG_AREAS : []) {
    const r = report.rag?.[a.id];
    if (!r) continue;
    out.push(`| ${a.label} | ${ragLabel(r.value)} | ${esc(r.reason || (r.why || []).join('; ')).replace(/\|/g, '\\|')} |`);
  }
  if (head) out.push('');
  if (report.summary) out.push('## Summary', '', report.summary, '');
  for (const sec of visibleSections(report)) {
    const s = report.sections[sec.id];
    const items = s.items || [];
    if (!items.length && !s.text) continue;
    out.push(`## ${sec.label}${sec.id === 'time' && s.total ? `: ${s.total} h` : ''}`, '');
    for (const g of groups(sec.id, items)) {
      if (g.title && groups(sec.id, items).length > 1) out.push(`**${esc(g.title)}**`, '');
      for (const x of g.items) out.push(`- ${itemLine(sec.id, x)}`);
      if (g.items.length) out.push('');
    }
    if (s.text) out.push(s.text, '');
  }
  return (
    out
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim() + '\n'
  );
}
