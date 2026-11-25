// Comments and reactions on issues.
import { body, fail, str } from '../lib/http.js';
import { uuid, now } from '../lib/crypto.js';
import { projectAccess, deniedMessage } from '../lib/access.js';
import { slackNotify } from '../lib/slack.js';
import { emailNotify } from '../lib/email.js';
import { webhookNotify } from '../lib/webhooks.js';
import { avatarUrl } from '../lib/avatars.js';
import { commentReactions, REACTIONS } from '../lib/comments.js';
import { changeSource } from '../lib/history.js';
import { mentionedIds } from '../lib/issues/model.js';
import { loadIssue, reachable } from '../lib/issues/guards.js';
import { notices, noticeStmts, watchStmt, watcherIds } from '../lib/notifications.js';

export function registerComments(app) {
  // ---- comments ----
  app.post('/api/issues/:key/comments', async (c) => {
    const { row, access, db } = await loadIssue(c, c.req.param('key'), 'comment');
    const user = c.get('user');
    const b = await body(c);
    const text = str(b.body, { required: true, max: 20000, name: 'Comment' });
    // Internal note: hidden from guests (comment list, activity, notifications, emails, digest). Team members only.
    let internal = Boolean(b.internal);
    if (internal && access.guest) fail(403, 'Guests cannot add internal notes');
    // Threaded reply: parentId is any comment of the thread; the reply attaches to its top comment (one level).
    // A reply to an internal note is internal too.
    let parent = null;
    if (b.parentId) {
      const p = await db.get('SELECT id, parent_id, internal FROM comments WHERE id = ? AND issue_id = ?', [String(b.parentId), row.id]);
      const top = p?.parent_id
        ? await db.get('SELECT id, parent_id, internal, author_id FROM comments WHERE id = ? AND issue_id = ?', [p.parent_id, row.id])
        : p;
      if (!top || (access.guest && (Number(top.internal) || Number(p.internal)))) fail(404, 'Comment to reply to not found');
      parent = top;
      if (Number(top.internal)) internal = true;
    }
    const id = uuid();
    const t = now();
    const watchers = await reachable(db, row.project_id, await watcherIds(db, row.id), { internal });
    const mentions = await reachable(db, row.project_id, mentionedIds(text), { internal });
    // Thread participants: the top comment's author and earlier repliers (not removed comments)
    let thread = [];
    let topAuthor = null;
    if (parent) {
      const people = await db.all(
        'SELECT id, author_id FROM comments WHERE (id = ? OR parent_id = ?) AND deleted_at IS NULL AND author_id IS NOT NULL ORDER BY created_at',
        [parent.id, parent.id],
      );
      topAuthor = people.find((x) => x.id === parent.id)?.author_id || null;
      thread = await reachable(db, row.project_id, [...new Set(people.map((x) => x.author_id))], { internal });
      thread = thread.filter((u) => !mentions.includes(u));
    }
    const me = await db.get('SELECT avatar_version FROM users WHERE id = ?', [user.id]);
    const stmts = [
      {
        sql: 'INSERT INTO comments (id, issue_id, author_id, body, internal, parent_id, created_at, updated_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        params: [id, row.id, user.id, text, internal ? 1 : 0, parent?.id || null, t, t, changeSource(c)],
      },
      { sql: 'UPDATE issues SET updated_at = ? WHERE id = ?', params: [t, row.id] },
      watchStmt(row.id, user.id),
    ];
    const notes = [
      ...notices(mentions, {
        type: 'mentioned',
        issueId: row.id,
        actorId: user.id,
        message: `${user.name} mentioned you on ${row.key}`,
        selfMessage: `You mentioned yourself on ${row.key}`,
      }),
      ...notices(
        thread.filter((u) => u === topAuthor),
        { type: 'reply', issueId: row.id, actorId: user.id, message: `${user.name} replied to your comment on ${row.key}` },
      ),
      ...notices(
        thread.filter((u) => u !== topAuthor),
        { type: 'reply', issueId: row.id, actorId: user.id, message: `${user.name} replied in a thread you are in on ${row.key}` },
      ),
      ...notices(
        watchers.filter((w) => !mentions.includes(w) && !thread.includes(w)),
        { type: 'comment', issueId: row.id, actorId: user.id, message: `${user.name} commented on ${row.key}: ${row.title}` },
      ),
    ];
    await db.batch([...stmts, ...noticeStmts(notes)]);
    slackNotify(c, { type: 'comment_added', issueId: row.id, comment: text, mentioned: mentions, reply: Boolean(parent) }); // Slack, in the background
    emailNotify(c, notes, { text }); // email, in the background
    webhookNotify(c, { event: 'comment.created', issueId: row.id, projectId: row.project_id, commentId: id, internal }); // outgoing webhooks (internal notes only to those that opt in)
    return c.json(
      {
        comment: {
          id,
          body: text,
          internal,
          parentId: parent?.id || null,
          deleted: false,
          reactions: [],
          createdAt: t,
          updatedAt: t,
          author: { id: user.id, name: user.name, avatarColor: user.avatar_color, avatarUrl: avatarUrl(user.id, me?.avatar_version) },
          mine: true,
        },
      },
      201,
    );
  });

  async function ownComment(c) {
    const db = c.env.db;
    const cm = await db.get('SELECT * FROM comments WHERE id = ?', [c.req.param('id')]);
    if (!cm) fail(404, 'Comment not found');
    const access = await (async () => {
      const issue = await db.get('SELECT project_id FROM issues WHERE id = ? AND deleted_at IS NULL', [cm.issue_id]);
      if (!issue) fail(404, 'Comment not found');
      return projectAccess(c, issue.project_id, 'view');
    })();
    const user = c.get('user');
    if (cm.internal && access.guest) fail(404, 'Comment not found'); // guests never see internal notes
    if (cm.deleted_at) fail(404, 'Comment not found'); // a removed comment kept only as a thread placeholder
    return { cm, db, user, isAuthor: cm.author_id === user.id, canAdmin: access.canAdmin, guest: access.guest, access };
  }

  app.patch('/api/comments/:id', async (c) => {
    const { cm, db, isAuthor, guest } = await ownComment(c);
    if (!isAuthor) fail(403, 'You can only edit your own comments');
    const b = await body(c);
    const text = str(b.body, { required: true, max: 20000, name: 'Comment' });
    // internal: true or false makes the comment an internal note or not (team members only)
    if (b.internal !== undefined && Boolean(b.internal) !== Boolean(cm.internal) && guest) fail(403, 'Guests cannot add internal notes');
    let internal = b.internal === undefined ? cm.internal : b.internal ? 1 : 0;
    // A reply in an internal thread stays internal; making a top comment internal makes its replies internal too.
    if (cm.parent_id && !internal) {
      const top = await db.get('SELECT internal FROM comments WHERE id = ?', [cm.parent_id]);
      if (Number(top?.internal)) internal = 1;
    }
    const stmts = [
      { sql: 'UPDATE comments SET body = ?, internal = ?, updated_at = ? WHERE id = ?', params: [text, internal, now(), cm.id] },
    ];
    if (!cm.parent_id && internal && !Number(cm.internal))
      stmts.push({ sql: 'UPDATE comments SET internal = 1 WHERE parent_id = ?', params: [cm.id] });
    await db.batch(stmts);
    return c.json({ ok: true });
  });

  app.delete('/api/comments/:id', async (c) => {
    const { cm, db, isAuthor, canAdmin } = await ownComment(c);
    if (!isAuthor && !canAdmin) fail(403, 'You can only delete your own comments');
    // A top comment with replies stays as a "Comment deleted" placeholder so the replies keep their place.
    // Removing the last reply under such a placeholder removes the placeholder too.
    const replies = cm.parent_id ? null : await db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM comments WHERE parent_id = ?', [cm.id]);
    if (replies && Number(replies.n) > 0) {
      await db.batch([
        { sql: `UPDATE comments SET body = '', deleted_at = ?, updated_at = ? WHERE id = ?`, params: [now(), now(), cm.id] },
        { sql: 'DELETE FROM comment_reactions WHERE comment_id = ?', params: [cm.id] },
      ]);
      return c.json({ ok: true, placeholder: true });
    }
    const stmts = [{ sql: 'DELETE FROM comments WHERE id = ?', params: [cm.id] }];
    if (cm.parent_id) {
      const top = await db.get('SELECT deleted_at FROM comments WHERE id = ?', [cm.parent_id]);
      const left = await db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM comments WHERE parent_id = ? AND id <> ?', [
        cm.parent_id,
        cm.id,
      ]);
      if (top?.deleted_at && !Number(left?.n)) stmts.push({ sql: 'DELETE FROM comments WHERE id = ?', params: [cm.parent_id] });
    }
    await db.batch(stmts);
    return c.json({ ok: true });
  });

  // ---- reactions (lib/comments.js): toggle one per person; no notifications ----
  async function react(c, on) {
    const { cm, db, user, access } = await ownComment(c); // 404 for comments the caller cannot see
    const reaction = c.req.param('reaction');
    if (!REACTIONS.includes(reaction)) fail(400, `Reaction must be one of: ${REACTIONS.join(', ')}`);
    if (!access.canComment) fail(403, deniedMessage(access.project, access, 'comment'));
    if (on) {
      await db.run('INSERT INTO comment_reactions (comment_id, user_id, reaction, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', [
        cm.id,
        user.id,
        reaction,
        now(),
      ]);
    } else {
      await db.run('DELETE FROM comment_reactions WHERE comment_id = ? AND user_id = ? AND reaction = ?', [cm.id, user.id, reaction]);
    }
    return c.json({ reactions: await commentReactions(db, cm.id, user.id) });
  }
  app.post('/api/comments/:id/reactions/:reaction', (c) => react(c, true));
  app.delete('/api/comments/:id/reactions/:reaction', (c) => react(c, false));
}
