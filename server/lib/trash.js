// The Trash: deleted issues are kept for `trashDays` (setting, default 30), then removed for good.
//
// Deleting an issue (single or bulk) sets deleted_at / deleted_by on it and on its live sub-tasks; the sub-tasks
// also get deleted_with = the parent's id, so a restore brings them back together. Every list and read of issues
// skips rows with deleted_at set (issueFilter, loadIssue and the other queries; see test/trash.test.js).
// Issue keys stay reserved: numbers come from projects.issue_seq, which never goes back.
//
// Restore: clears the three columns on the item and on the sub-tasks deleted with it. A story or task whose parent
// epic is gone (in the Trash or removed) comes back without a parent. A sub-task deleted on its own whose parent is
// in the Trash cannot be restored until the parent is.
//
// Delete forever (project admins and admins) and the daily trash_purge job use hardDeleteIssue: the same removal
// the API used before the Trash existed (rows cascade: comments, history, labels, links, watchers, worklogs,
// attachments with their database chunks, notifications; R2/GCS objects are deleted through files.js).
import { audit } from './audit.js';
import { historyStmt } from './history.js';
import { deleteExternal } from './files.js';
import { fail } from './http.js';

/** Move one issue and its live sub-tasks to the Trash. opts.audit = false skips the issue.trashed row (bulk writes one). */
export async function trashIssue(db, issue, actorId, t, opts = {}) {
  const kids = await db.get(
    `SELECT CAST(COUNT(*) AS INTEGER) AS n FROM issues WHERE parent_id = ? AND type = 'subtask' AND deleted_at IS NULL`,
    [issue.id],
  );
  const stmts = [
    {
      sql: `UPDATE issues SET deleted_at = ?, deleted_by = ?, deleted_with = ? WHERE parent_id = ? AND type = 'subtask' AND deleted_at IS NULL`,
      params: [t, actorId, issue.id, issue.id],
    },
    { sql: 'UPDATE issues SET deleted_at = ?, deleted_by = ?, deleted_with = NULL WHERE id = ?', params: [t, actorId, issue.id] },
  ];
  if (opts.audit !== false)
    stmts.push(audit(actorId, 'issue.trashed', 'issue', issue.id, { key: issue.key, title: issue.title, subtasks: kids.n }, t));
  await db.batch(stmts);
  return { subtasks: kids.n };
}

/** Restore a Trash item (a row with deleted_at set). Returns { subtasks, parentDropped } (the old parent key or null). */
export async function restoreIssue(db, row, actorId, t) {
  if (row.deleted_with) {
    const p = await db.get('SELECT key FROM issues WHERE id = ?', [row.deleted_with]);
    fail(400, `${row.key} was deleted with ${p?.key || 'its parent'}. Restore that instead.`);
  }
  let dropParent = false;
  let parentKey = null;
  if (row.parent_id) {
    const p = await db.get('SELECT key, deleted_at FROM issues WHERE id = ?', [row.parent_id]);
    if (row.type === 'subtask') {
      if (!p) fail(400, 'The parent of this sub-task no longer exists');
      if (p.deleted_at) fail(400, `Its parent ${p.key} is in the Trash. Restore that first.`);
    } else if (!p || p.deleted_at) {
      dropParent = true; // the parent epic is gone: restore without a parent
      parentKey = p?.key || null;
    }
  }
  const kids = await db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM issues WHERE deleted_with = ?', [row.id]);
  const stmts = [
    { sql: 'UPDATE issues SET deleted_at = NULL, deleted_by = NULL, deleted_with = NULL WHERE deleted_with = ?', params: [row.id] },
    {
      sql: `UPDATE issues SET deleted_at = NULL, deleted_by = NULL, deleted_with = NULL, updated_at = ?${dropParent ? ', parent_id = NULL' : ''} WHERE id = ?`,
      params: [t, row.id],
    },
    historyStmt(row.id, actorId, 'restored', null, null, t),
    ...(dropParent ? [historyStmt(row.id, actorId, 'parent', parentKey, null, t)] : []),
    audit(
      actorId,
      'issue.restored',
      'issue',
      row.id,
      { key: row.key, title: row.title, subtasks: kids.n, ...(dropParent ? { parentDropped: parentKey } : {}) },
      t,
    ),
  ];
  await db.batch(stmts);
  return { subtasks: kids.n, parentDropped: dropParent ? parentKey : null };
}

/**
 * Remove an issue and its sub-tasks for good (incl. attachments and R2/GCS objects). 4 queries plus one delete per
 * external file. actorId null = the purge job. Writes an issue.purged audit row.
 */
export async function hardDeleteIssue(env, issue, actorId, t, reason) {
  const db = env.db;
  const kids = await db.get(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM issues WHERE parent_id = ? AND type = 'subtask'`, [issue.id]);
  // Attachments stored outside the database (R2/GCS); database chunks cascade with the rows.
  const external = await db.all(
    `SELECT a.id, a.storage FROM attachments a JOIN issues i ON i.id = a.issue_id
      WHERE a.storage <> 'db' AND (i.id = ? OR (i.parent_id = ? AND i.type = 'subtask'))`,
    [issue.id, issue.id],
  );
  await db.batch([
    { sql: `DELETE FROM issues WHERE parent_id = ? AND type = 'subtask'`, params: [issue.id] },
    { sql: 'UPDATE issues SET parent_id = NULL WHERE parent_id = ?', params: [issue.id] },
    { sql: 'DELETE FROM issues WHERE id = ?', params: [issue.id] },
    audit(
      actorId,
      'issue.purged',
      'issue',
      issue.id,
      { key: issue.key, title: issue.title, subtasks: kids.n, reason, deletedAt: issue.deleted_at || null },
      t,
    ),
  ]);
  await deleteExternal(env, external);
  return { subtasks: kids.n, files: external.length };
}

/** Trash items (deleted on their own, not with a parent) older than `days`, oldest first. */
export function expiredItems(db, cutoffIso, limit) {
  return db.all(
    `SELECT id, key, title, deleted_at FROM issues WHERE deleted_at IS NOT NULL AND deleted_at < ? AND deleted_with IS NULL ORDER BY deleted_at, id LIMIT ?`,
    [cutoffIso, limit],
  );
}
