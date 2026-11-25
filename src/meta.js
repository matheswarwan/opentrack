// Issue vocabulary: the ids come from shared/issueMeta.js (the server validates against the same lists); labels and
// colours are the browser's.
import { TYPES as TYPE_IDS, PRIORITIES as PRIORITY_IDS, STATUS_CATEGORIES, LINK_TYPES as LINK_IDS } from '../shared/issueMeta.js';

const TYPE_LOOK = {
  epic: { label: 'Epic', color: '#a16207', glyph: 'E' },
  story: { label: 'Story', color: '#1d7a46', glyph: 'S' },
  task: { label: 'Task', color: '#3f3f46', glyph: 'T' },
  bug: { label: 'Bug', color: '#b42318', glyph: 'B' },
  subtask: { label: 'Sub-task', color: '#78716c', glyph: 's' },
};
export const TYPES = TYPE_IDS.map((id) => ({ id, ...TYPE_LOOK[id] }));
export const typeOf = (id) => TYPES.find((t) => t.id === id) || TYPES[2];

const PRIORITY_LOOK = {
  highest: { label: 'Highest', color: '#b91c1c', arrow: '⇈' },
  high: { label: 'High', color: '#ea580c', arrow: '↑' },
  medium: { label: 'Medium', color: '#ca8a04', arrow: '=' },
  low: { label: 'Low', color: '#57534e', arrow: '↓' },
  lowest: { label: 'Lowest', color: '#a8a29e', arrow: '⇊' },
};
export const PRIORITIES = PRIORITY_IDS.map((id) => ({ id, ...PRIORITY_LOOK[id] }));
export const priorityOf = (id) => PRIORITIES.find((p) => p.id === id) || PRIORITIES[2];

const CATEGORY_LOOK = {
  todo: { label: 'To do', cls: 'bg-slate-200 text-slate-700' },
  in_progress: { label: 'In progress', cls: 'bg-blue-100 text-blue-800' },
  done: { label: 'Done', cls: 'bg-green-100 text-green-800' },
};
export const CATEGORIES = STATUS_CATEGORIES.map((id) => ({ id, ...CATEGORY_LOOK[id] }));
export const categoryCls = (c) => (CATEGORIES.find((x) => x.id === c) || CATEGORIES[0]).cls;

const LINK_WORDS = {
  blocks: { out: 'blocks', in: 'is blocked by' },
  relates: { out: 'relates to', in: 'relates to' },
  duplicates: { out: 'duplicates', in: 'is duplicated by' },
  clones: { out: 'clones', in: 'is cloned by' },
};
export const LINK_TYPES = LINK_IDS.map((id) => ({ id, ...LINK_WORDS[id] }));

export function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}
export const fmtDate = (iso) =>
  iso
    ? new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : '';
export const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

export const FIELD_LABELS = {
  created: 'created',
  title: 'changed the title',
  description: 'updated the description',
  status: 'changed the status',
  assignee: 'changed the assignee',
  reporter: 'changed the reporter',
  priority: 'changed the priority',
  type: 'changed the type',
  parent: 'changed the parent',
  sprint: 'changed the sprint',
  story_points: 'changed story points',
  estimate_hours: 'changed the estimate',
  due_date: 'changed the due date',
  start_date: 'changed the start date',
  labels: 'changed labels',
  components: 'changed components',
  fix_versions: 'changed fix versions',
  link: 'linked an issue',
  attachment: 'changed attachments',
  internal_attachment: 'changed internal files',
  restored: 'restored this from the Trash',
  recurring: 'created this with a recurring rule',
};

/** "Blocked by WEB-3, WEB-9" (blockers in projects the viewer cannot see are counted, not named). */
export function blockedText(issue) {
  const keys = issue?.blockedBy || [];
  const hidden = issue?.blockedHidden || 0;
  const unseen = hidden ? `${hidden === 1 ? 'an issue' : `${hidden} issues`} you cannot see` : '';
  if (!keys.length) return unseen ? `Blocked by ${unseen}` : 'Blocked';
  return `Blocked by ${keys.join(', ')}${unseen ? ` and ${unseen}` : ''}`;
}

/** Sentence for an activity item, before the issue key: 'created', 'commented on', 'changed the status on'. */
export function activityVerb(a) {
  if (a.kind === 'comment') return 'commented on';
  if (a.field === 'created') return 'created';
  if (a.field === 'link') return 'linked';
  if (a.field === 'restored') return 'restored from the Trash';
  if (a.field === 'recurring') return 'created with a recurring rule';
  if (String(a.field || '').startsWith('field:')) return `changed ${a.field.slice(6)} on`; // custom fields
  return `${FIELD_LABELS[a.field] || a.field}${a.field === 'status' ? '' : ' on'}`;
}
