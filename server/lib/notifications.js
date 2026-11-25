// In-app notifications (the notifications table) and watchers.
//
// A notice is one notification as a record:
//   { userId, type, message, issueId, actorId, projectId, link, at }   (all but userId, type and message optional)
// Code builds and filters notices as records, then noticeStmts(records) turns them into inserts for the batch.
// The same records go to emailNotify (lib/email.js), so email follows what the in-app rules decided.
import { uuid, now } from './crypto.js';

/**
 * Notices of one kind for a list of people. The actor is never notified of their own change, except a mention of
 * themselves (people tag themselves as a reminder), which notifies them with selfMessage.
 */
export function notices(userIds, { type, issueId = null, actorId = null, message, selfMessage = null, projectId = null, link = null }) {
  return [...new Set(userIds.filter((id) => id && (id !== actorId || selfMessage)))].map((uid) => ({
    userId: uid,
    type,
    issueId,
    actorId,
    message: uid === actorId ? selfMessage : message,
    projectId,
    link,
    at: now(),
  }));
}

/** The inserts for a list of notices. */
export function noticeStmts(records) {
  return records.map((n) => ({
    sql: 'INSERT INTO notifications (id, user_id, type, issue_id, actor_id, message, created_at, project_id, link) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    params: [uuid(), n.userId, n.type, n.issueId ?? null, n.actorId ?? null, n.message, n.at || now(), n.projectId ?? null, n.link ?? null],
  }));
}

export const watchStmt = (issueId, userId) => ({
  sql: 'INSERT INTO watchers (issue_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
  params: [issueId, userId],
});

export async function watcherIds(db, issueId) {
  return (await db.all('SELECT user_id FROM watchers WHERE issue_id = ?', [issueId])).map((r) => r.user_id);
}
