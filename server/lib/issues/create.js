// Creating issues: number and rank allocation, the default status, the one insert path, and telling the outside
// world. Callers decide explicitly whether a new issue is announced (announceCreated) or stays silent.
import { slackNotify } from '../slack.js';
import { emailNotify } from '../email.js';
import { webhookNotify } from '../webhooks.js';
import { historyStmt } from '../history.js';
import { notices, watchStmt } from '../notifications.js';
import { RANK_STEP, mentionedIds } from './model.js';
import { placeholders } from '../../db/sql.js';

/** The columns of an issue row, in insert order (the Jira import fills the same list with its own values). */
export const ISSUE_COLUMNS = [
  'id',
  'project_id',
  'number',
  'key',
  'type',
  'title',
  'description',
  'status_id',
  'priority',
  'assignee_id',
  'reporter_id',
  'parent_id',
  'sprint_id',
  'story_points',
  'estimate_hours',
  'due_date',
  'rank',
  'created_at',
  'updated_at',
  'resolved_at',
  'start_date',
];
export const ISSUE_INSERT_SQL = `INSERT INTO issues (${ISSUE_COLUMNS.join(', ')}) VALUES (${placeholders(ISSUE_COLUMNS.length)})`;

/**
 * Reserve the next n issue numbers of a project and find where new issues go in the rank order (after everything).
 * Returns { first, number(i), rank(i) } for i = 0 .. n - 1. Two queries.
 */
export async function allocate(db, project, n = 1) {
  const seq = await db.get('UPDATE projects SET issue_seq = issue_seq + ? WHERE id = ? RETURNING issue_seq', [n, project.id]);
  const maxRank = await db.get('SELECT MAX(rank) AS m FROM issues WHERE project_id = ?', [project.id]);
  const first = Number(seq.issue_seq) - n + 1;
  const base = maxRank?.m ?? 0;
  return { first, number: (i) => first + i, rank: (i) => base + (i + 1) * RANK_STEP };
}

/** The status new issues start in: the project's first one ({ id, category }), or nothing when it has none. */
export function firstStatus(db, projectId) {
  return db.get('SELECT id, category FROM statuses WHERE project_id = ? ORDER BY position LIMIT 1', [projectId]);
}

/**
 * What creates one issue, as { stmts, notices }: the row, its 'created' history entry, labels and watchers (reporter,
 * the actor and the assignee, but never f.neverWatches), and the notices (assignee, mentions) as records for the
 * caller to filter and write with noticeStmts in the same batch.
 * The one insert path: POST /api/issues, recurring rules, the CSV import and channel AI sub-tasks. f.source: where the change came from (lib/history.js changeSource).
 */
export function issueInsertStatements(f) {
  const { id, project, number, actor, t } = f;
  const key = `${project.key}-${number}`;
  const stmts = [
    {
      sql: ISSUE_INSERT_SQL,
      params: [
        id,
        project.id,
        number,
        key,
        f.type,
        f.title,
        f.description,
        f.statusId,
        f.priority,
        f.assigneeId,
        f.reporterId,
        f.parentId,
        f.sprintId,
        f.storyPoints,
        f.estimateHours,
        f.dueDate,
        f.rank,
        t,
        t,
        f.done ? t : null,
        f.startDate ?? null, // Roadmap start date (optional)
      ],
    },
    historyStmt(id, actor.id, 'created', null, key, t, f.source),
    ...(f.labels || []).map((l) => ({ sql: 'INSERT INTO issue_labels (issue_id, label) VALUES (?, ?)', params: [id, l] })),
    ...[...new Set([f.reporterId, actor.id, f.assigneeId].filter((uid) => uid && uid !== f.neverWatches))].map((uid) => watchStmt(id, uid)),
  ];
  const notes = [];
  if (f.assigneeId) {
    notes.push(
      ...notices([f.assigneeId], {
        type: 'assigned',
        issueId: id,
        actorId: actor.id,
        message: `${actor.name} assigned ${key} to you: ${f.title}`,
      }),
    );
  }
  notes.push(
    ...notices(mentionedIds(f.description), {
      type: 'mentioned',
      issueId: id,
      actorId: actor.id,
      message: `${actor.name} mentioned you in ${key}`,
      selfMessage: `You mentioned yourself in ${key}`,
    }),
  );
  return { stmts, notices: notes };
}

/**
 * Tell the outside world about a created issue, in the background: Slack, outgoing webhooks (issue.created) and
 * email. Call after the batch has committed. c: the request context (a job passes detachedContext from lib/http.js).
 * created: { issueId, projectId, assigneeId, mentioned (user ids to DM), notices (the ones written), description }.
 */
export function announceCreated(c, { issueId, projectId, assigneeId = null, mentioned = [], notices: written = [], description = null }) {
  slackNotify(c, { type: 'issue_created', issueId, assigned: [assigneeId], mentioned }); // Slack, in the background
  webhookNotify(c, { event: 'issue.created', issueId, projectId }); // outgoing webhooks, in the background
  emailNotify(c, written, { text: description }); // email, in the background
}
