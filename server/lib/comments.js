// Comment reactions and threads (migration 0020).
//
// Reactions: a fixed set of short ids; the UI draws the emoji. One row per person, comment and reaction.
// Threads: comments.parent_id points to the top comment (one level). A comment with replies is soft deleted
// (deleted_at set, body emptied) so the thread keeps its place; the payload shows it as "Comment deleted".

export const REACTIONS = ['thumbsup', 'check', 'eyes', 'heart', 'laugh', 'party'];

/** Reactions of every comment on an issue, in one query: Map comment id -> [{ reaction, count, users, mine }]. */
export async function issueReactions(db, issueId, userId) {
  const rows = await db.all(
    `SELECT r.comment_id, r.reaction, r.user_id, u.name FROM comment_reactions r JOIN comments cm ON cm.id = r.comment_id
       LEFT JOIN users u ON u.id = r.user_id WHERE cm.issue_id = ? ORDER BY r.created_at`,
    [issueId],
  );
  return groupReactions(rows, userId);
}

/** Reactions of one comment. */
export async function commentReactions(db, commentId, userId) {
  const rows = await db.all(
    `SELECT r.comment_id, r.reaction, r.user_id, u.name FROM comment_reactions r LEFT JOIN users u ON u.id = r.user_id
      WHERE r.comment_id = ? ORDER BY r.created_at`,
    [commentId],
  );
  return groupReactions(rows, userId).get(commentId) || [];
}

function groupReactions(rows, userId) {
  const byComment = new Map();
  for (const r of rows) {
    if (!REACTIONS.includes(r.reaction)) continue;
    if (!byComment.has(r.comment_id)) byComment.set(r.comment_id, new Map());
    const m = byComment.get(r.comment_id);
    if (!m.has(r.reaction)) m.set(r.reaction, { reaction: r.reaction, count: 0, users: [], mine: false });
    const g = m.get(r.reaction);
    g.count += 1;
    g.users.push({ id: r.user_id, name: r.name || 'Former user' });
    if (r.user_id === userId) g.mine = true;
  }
  const out = new Map();
  for (const [id, m] of byComment)
    out.set(
      id,
      REACTIONS.filter((x) => m.has(x)).map((x) => m.get(x)),
    );
  return out;
}

/**
 * Order a flat comment list for display data: top comments keep their order, each reply follows the list order.
 * Replies whose top comment the viewer cannot see (a guest and an internal thread) are left out.
 */
export function visibleThreads(rows) {
  const ids = new Set(rows.map((r) => r.id));
  return rows.filter((r) => !r.parent_id || ids.has(r.parent_id));
}
