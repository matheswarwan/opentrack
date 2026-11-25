// Issues: constants, the list SELECT and its output shape, and small pure checks.
import { fail } from '../http.js';
import { avatarUrl } from '../avatars.js';
import { placeholders, chunks, notDeleted } from '../../db/sql.js';

export { TYPES, PRIORITIES, LINK_TYPES, STATUS_CATEGORIES } from '../../../shared/issueMeta.js';
export const RANK_STEP = 1000;

// The issue's own columns that lists show (no description: it is large and only the detail view reads it).
const OWN_COLUMNS = `i.id, i.key, i.number, i.project_id, i.type, i.title, i.status_id, i.priority, i.assignee_id, i.reporter_id,
  i.sprint_id, i.story_points, i.estimate_hours, i.due_date, i.rank, i.start_date, i.created_at, i.updated_at, i.resolved_at`;
// Names from the joined tables. The parent comes from pi, so a parent in the Trash shows as no parent.
const JOINED_COLUMNS = `p.key AS project_key, p.name AS project_name, s.name AS status_name, s.category AS status_category,
  a.name AS assignee_name, a.avatar_color AS assignee_color, a.avatar_version AS assignee_avatar,
  r.name AS reporter_name, r.avatar_color AS reporter_color, r.avatar_version AS reporter_avatar,
  pi.key AS parent_key, pi.title AS parent_title, pi.type AS parent_type, sp.name AS sprint_name`;

/**
 * The tables behind every issue query, with the aliases the shared fragments rely on: i issues, p projects,
 * s statuses, a assignee, r reporter, pi parent issue (live ones only), sp sprints. issueFilter, the sort columns
 * and visibleProjectsSql(user) write their conditions against these names.
 */
export const ISSUE_FROM = `FROM issues i JOIN projects p ON p.id = i.project_id JOIN statuses s ON s.id = i.status_id
  LEFT JOIN users a ON a.id = i.assignee_id LEFT JOIN users r ON r.id = i.reporter_id
  LEFT JOIN issues pi ON pi.id = i.parent_id AND ${notDeleted('pi')} LEFT JOIN sprints sp ON sp.id = i.sprint_id`;

/** The list SELECT (the columns issueOut reads) over ISSUE_FROM; callers add WHERE and ORDER BY. */
export const ISSUE_SELECT = `SELECT ${OWN_COLUMNS}, pi.id AS parent_id, ${JOINED_COLUMNS}
  ${ISSUE_FROM}`;

/**
 * For a write: the whole issues row (i.*, so parent_id is the stored one even when that parent is in the Trash) plus
 * the joined names, with the live parent's id as live_parent_id. splitFullRow turns one such row into the two shapes.
 */
export const ISSUE_FULL_SELECT = `SELECT i.*, pi.id AS live_parent_id, ${JOINED_COLUMNS}
  ${ISSUE_FROM}`;

/** An ISSUE_FULL_SELECT row as { row, current }: row has the ISSUE_SELECT shape, current is the stored issues row. */
export function splitFullRow(full) {
  return { row: { ...full, parent_id: full.live_parent_id }, current: full };
}
// Issues in the Trash (deleted_at set) are left out everywhere: issueFilter adds notDeleted('i'), loadIssue
// answers 404, and a parent in the Trash shows as no parent (pi joins only live issues). See server/lib/trash.js.

export function issueOut(r, labels = []) {
  return {
    id: r.id,
    key: r.key,
    number: r.number,
    projectId: r.project_id,
    projectKey: r.project_key,
    projectName: r.project_name,
    type: r.type,
    title: r.title,
    status: { id: r.status_id, name: r.status_name, category: r.status_category },
    priority: r.priority,
    assignee: r.assignee_id
      ? { id: r.assignee_id, name: r.assignee_name, avatarColor: r.assignee_color, avatarUrl: avatarUrl(r.assignee_id, r.assignee_avatar) }
      : null,
    reporter: r.reporter_id
      ? { id: r.reporter_id, name: r.reporter_name, avatarColor: r.reporter_color, avatarUrl: avatarUrl(r.reporter_id, r.reporter_avatar) }
      : null,
    parent: r.parent_id ? { id: r.parent_id, key: r.parent_key, title: r.parent_title, type: r.parent_type } : null,
    sprint: r.sprint_id ? { id: r.sprint_id, name: r.sprint_name } : null,
    storyPoints: r.story_points,
    estimateHours: r.estimate_hours,
    dueDate: r.due_date,
    startDate: r.start_date ?? null,
    rank: r.rank,
    labels,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    resolvedAt: r.resolved_at,
  };
}

export async function withLabels(db, rows) {
  if (!rows.length) return [];
  const map = new Map();
  for (const part of chunks(rows)) {
    const ids = part.map((r) => r.id);
    const labels = await db.all(
      `SELECT issue_id, label FROM issue_labels WHERE issue_id IN (${placeholders(ids.length)}) ORDER BY label`,
      ids,
    );
    for (const l of labels) {
      if (!map.has(l.issue_id)) map.set(l.issue_id, []);
      map.get(l.issue_id).push(l.label);
    }
  }
  return rows.map((r) => issueOut(r, map.get(r.id) || []));
}

/** Roadmap dates: the start date may not be after the due date. Returns start. */
export function checkDates(start, due) {
  if (start && due && start > due) fail(400, 'Start date must be on or before the due date');
  return start;
}

const MENTION_RE = /@\[[^\]]{1,100}\]\(user:([0-9a-f-]{36})\)/g;
export function mentionedIds(text) {
  return [...new Set([...String(text || '').matchAll(MENTION_RE)].map((m) => m[1]))];
}

export function cleanLabels(v) {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) fail(400, 'labels must be a list');
  const out = [...new Set(v.map((l) => String(l).trim().replace(/\s+/g, '-')).filter(Boolean))];
  if (out.length > 20) fail(400, 'At most 20 labels');
  if (out.some((l) => l.length > 40)) fail(400, 'Labels are at most 40 characters');
  return out;
}

/** Why an issue of `type` cannot have a parent of `parentType`, or null when it can. */
export function parentTypeError(type, parentType) {
  if (type === 'epic') return 'An epic cannot have a parent';
  if (type === 'subtask' && (parentType === 'subtask' || parentType === 'epic')) return 'A sub-task parent must be a story, task or bug';
  if (type !== 'subtask' && parentType !== 'epic') return 'Only epics can be parents of stories, tasks and bugs';
  return null;
}
