import { body, fail, str, oneOf, num, isoDate } from '../lib/http.js';
import { uuid, now } from '../lib/crypto.js';
import {
  projectAccess,
  visibleProjectsSql,
  inScope,
  userCanSee,
  commentVisibleSql,
  historyVisibleSql,
  attachmentVisibleSql,
} from '../lib/access.js';
import { avatarUrl } from '../lib/avatars.js';
import { ATTACHMENT_SELECT, attachmentOut } from './attachments.js';
import { withFields } from '../lib/customFields.js';
import { withReleases } from '../lib/releases.js';
import { issueReactions, visibleThreads } from '../lib/comments.js';
import { today } from '../lib/time.js';
import { historyStmt, changeSource } from '../lib/history.js';
import { assertWeeksOpen } from '../lib/timeTracking.js';
import { LINK_TYPES, RANK_STEP, ISSUE_SELECT, withLabels } from '../lib/issues/model.js';
import { withBlocked, epicDependencies } from '../lib/issues/links.js';
import { searchIssues, csvFieldColumns } from '../lib/issues/search.js';
import { loadIssue } from '../lib/issues/guards.js';
import { addWorklog, createIssue, updateIssue, deleteIssue } from '../lib/issues/write.js';
import { notices, noticeStmts, watchStmt } from '../lib/notifications.js';
import { registerComments } from './comments.js';
import { registerBulk } from './bulk.js';
import { registerChannelAi } from './channelAi.js';
import { csvCell } from '../lib/csv.js';

// Values the board may send with a move when a workflow rule asks for them (POST /api/issues/:key/move { extra }).
const MOVE_EXTRA = ['assigneeId', 'storyPoints', 'estimateHours', 'dueDate', 'fixVersions', 'components', 'fields', 'comment'];

export function registerIssues(app) {
  app.get('/api/issues', async (c) => c.json(await searchIssues(c.env.db, c.get('user'), c.req.query())));

  app.get('/api/issues.csv', async (c) => {
    const res = await searchIssues(c.env.db, c.get('user'), { ...c.req.query(), limit: 1000 }, { fields: 'text', releases: true });
    const cols = [
      'Key',
      'Type',
      'Title',
      'Status',
      'Priority',
      'Assignee',
      'Reporter',
      'Sprint',
      'Story points',
      'Due',
      'Labels',
      'Components',
      'Fix versions',
      'Created',
      'Updated',
    ];
    const extra = csvFieldColumns(res); // custom fields of the projects in the result
    const lines = [[...cols, ...extra.map((f) => f.header)].map(csvCell).join(',')];
    for (const i of res.issues) {
      lines.push(
        [
          i.key,
          i.type,
          i.title,
          i.status.name,
          i.priority,
          i.assignee?.name,
          i.reporter?.name,
          i.sprint?.name,
          i.storyPoints,
          i.dueDate,
          i.labels.join(' '),
          i.components.map((x) => x.name).join(', '),
          i.fixVersions.map((x) => x.name).join(', '),
          i.createdAt,
          i.updatedAt,
          ...extra.map((f) => i.fields?.[f.id]),
        ]
          .map(csvCell)
          .join(','),
      );
    }
    return c.body(lines.join('\n'), 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="issues.csv"',
    });
  });

  app.post('/api/issues', async (c) => c.json({ issue: await createIssue(c, await body(c)) }, 201));

  app.get('/api/issues/:key', async (c) => {
    const { row, access, rights, db } = await loadIssue(c, c.req.param('key'));
    const user = c.get('user');
    const [issue] = await withBlocked(db, user, await withLabels(db, [row]));
    await withFields(db, [issue]);
    await withReleases(db, [issue]);
    const vis = visibleProjectsSql(user);
    const [comments, history, links, children, watchers, worklogs, attachments, recurring, reactions] = await Promise.all([
      db.all(
        `SELECT cm.id, cm.body, cm.internal, cm.parent_id, cm.deleted_at, cm.created_at, cm.updated_at, cm.author_id, cm.source, u.name, u.avatar_color, u.avatar_version FROM comments cm
           LEFT JOIN users u ON u.id = cm.author_id WHERE cm.issue_id = ?${commentVisibleSql(user)} ORDER BY cm.created_at`,
        [row.id],
      ),
      db.all(
        `SELECT h.id, h.field, h.old_value, h.new_value, h.created_at, h.actor_id, h.source, u.name, u.avatar_color, u.avatar_version FROM issue_history h
           LEFT JOIN users u ON u.id = h.actor_id WHERE h.issue_id = ?${historyVisibleSql(user)} ORDER BY h.created_at`,
        [row.id],
      ),
      db.all(
        `SELECT l.id, l.type, l.source_id, l.target_id, o.key, o.title, os.name AS status_name, os.category AS status_category,
                o.project_id, CASE WHEN l.source_id = ? THEN 'out' ELSE 'in' END AS direction
           FROM issue_links l JOIN issues o ON o.id = CASE WHEN l.source_id = ? THEN l.target_id ELSE l.source_id END
           JOIN statuses os ON os.id = o.status_id JOIN projects p ON p.id = o.project_id
          WHERE (l.source_id = ? OR l.target_id = ?) AND o.deleted_at IS NULL AND ${vis.sql} ORDER BY l.created_at`,
        [row.id, row.id, row.id, row.id, ...vis.params],
      ), // linked issues in projects the viewer cannot see are left out
      searchIssues(db, user, { parent: row.key, sort: 'rank', limit: 500, archived: '1' }),
      db.all(
        `SELECT w.user_id, u.name, u.avatar_color, u.avatar_version FROM watchers w JOIN users u ON u.id = w.user_id WHERE w.issue_id = ? ORDER BY LOWER(u.name)`,
        [row.id],
      ),
      db.all(
        `SELECT w.id, w.hours, w.note, w.work_date, w.created_at, w.user_id, w.source, w.billable, u.name FROM worklogs w
           LEFT JOIN users u ON u.id = w.user_id WHERE w.issue_id = ? ORDER BY w.work_date DESC, w.created_at DESC`,
        [row.id],
      ),
      db.all(`${ATTACHMENT_SELECT} WHERE a.issue_id = ?${attachmentVisibleSql(user)} ORDER BY a.created_at`, [row.id]),
      db.get('SELECT r.id, r.name FROM recurring_occurrences o JOIN recurring_rules r ON r.id = o.rule_id WHERE o.issue_id = ?', [row.id]),
      issueReactions(db, row.id, user.id), // reactions of every comment, one query (lib/comments.js)
    ]);
    const dependencies = row.type === 'epic' ? await epicDependencies(db, user, children.issues) : null;
    return c.json({
      issue: {
        ...issue,
        description: (await db.get('SELECT description FROM issues WHERE id = ?', [row.id])).description,
        canEdit: rights.canEdit,
        canDelete: rights.canDelete && !access.project.archived,
        canComment: rights.canComment,
        canWatch: rights.canWatch,
        canSprints: access.canSprints,
        canEditAny: access.canEdit, // false for guests (who may change only the issues they reported)
        guest: access.guest,
        // parentId: the top comment of the thread (null for top comments). deleted: a top comment removed while it had
        // replies, shown as "Comment deleted" (no body or author). reactions: [{ reaction, count, users, mine }].
        comments: visibleThreads(comments).map((x) =>
          x.deleted_at
            ? {
                id: x.id,
                body: '',
                internal: Boolean(Number(x.internal)),
                parentId: null,
                deleted: true,
                createdAt: x.created_at,
                updatedAt: x.created_at,
                author: null,
                mine: false,
                reactions: [],
              }
            : {
                id: x.id,
                body: x.body,
                internal: Boolean(Number(x.internal)),
                parentId: x.parent_id || null,
                deleted: false,
                createdAt: x.created_at,
                updatedAt: x.updated_at,
                source: x.source || null,
                author: x.author_id
                  ? { id: x.author_id, name: x.name, avatarColor: x.avatar_color, avatarUrl: avatarUrl(x.author_id, x.avatar_version) }
                  : null,
                mine: x.author_id === user.id,
                reactions: reactions.get(x.id) || [],
              },
        ),
        history: history.map((h) => ({
          id: h.id,
          field: h.field,
          from: h.old_value,
          to: h.new_value,
          createdAt: h.created_at,
          source: h.source || null,
          actor: h.name ? { name: h.name, avatarColor: h.avatar_color, avatarUrl: avatarUrl(h.actor_id, h.avatar_version) } : null,
        })),
        links: links
          .filter((l) => inScope(user, l.project_id))
          .map((l) => ({
            id: l.id,
            type: l.type,
            direction: l.direction,
            issue: { key: l.key, title: l.title, status: { name: l.status_name, category: l.status_category } },
          })),
        children: children.issues,
        watchers: watchers.map((w) => ({
          id: w.user_id,
          name: w.name,
          avatarColor: w.avatar_color,
          avatarUrl: avatarUrl(w.user_id, w.avatar_version),
        })),
        watching: watchers.some((w) => w.user_id === user.id),
        worklogs: worklogs.map((w) => ({
          id: w.id,
          hours: w.hours,
          note: w.note,
          workDate: w.work_date,
          createdAt: w.created_at,
          source: w.source || null,
          billable: Boolean(Number(w.billable)),
          user: { id: w.user_id, name: w.name },
          mine: w.user_id === user.id,
        })),
        loggedHours: worklogs.reduce((s, w) => s + Number(w.hours), 0),
        attachments: attachments.map((a) => attachmentOut(a, user.id)),
        recurring: recurring ? { id: recurring.id, name: recurring.name } : null,
        ...(dependencies ? { dependencies } : {}),
      },
    });
  });

  app.patch('/api/issues/:key', async (c) => c.json(await updateIssue(c, c.req.param('key'), await body(c))));

  // Board / backlog drag: optional new status or sprint, placed between prevKey and nextKey.
  app.post('/api/issues/:key/move', async (c) => {
    const loaded = await loadIssue(c, c.req.param('key'), 'edit', { full: true });
    const { row, db } = loaded;
    const b = await body(c);
    const neighbour = async (k) =>
      k ? db.get('SELECT rank FROM issues WHERE key = ? AND project_id = ?', [String(k).toUpperCase(), row.project_id]) : null;
    let [prev, next] = await Promise.all([neighbour(b.prevKey), neighbour(b.nextKey)]);
    let rank = row.rank;
    const compute = () => {
      if (prev && next) return (prev.rank + next.rank) / 2;
      if (prev) return prev.rank + RANK_STEP;
      if (next) return next.rank - RANK_STEP;
      return row.rank;
    };
    rank = compute();
    if (prev && next && Math.abs(next.rank - prev.rank) < 1e-6) {
      // ranks too close: renumber the project, then place again
      const all = await db.all('SELECT id FROM issues WHERE project_id = ? ORDER BY rank, created_at', [row.project_id]);
      await db.batch(all.map((r, i) => ({ sql: 'UPDATE issues SET rank = ? WHERE id = ?', params: [(i + 1) * RANK_STEP, r.id] })));
      [prev, next] = await Promise.all([neighbour(b.prevKey), neighbour(b.nextKey)]);
      rank = compute();
    }
    // status / sprint changes go through the normal update path (history, notifications, workflow rules), which saves
    // the rank in the same batch, so a refused move changes nothing. extra: values a workflow rule asked for (board dialog).
    const patch = {};
    if (b.statusId && b.statusId !== row.status_id) patch.statusId = b.statusId;
    if (b.sprintId !== undefined) patch.sprintId = b.sprintId === 'backlog' ? null : b.sprintId;
    if (patch.statusId && b.extra && typeof b.extra === 'object') {
      for (const k of MOVE_EXTRA) if (b.extra[k] !== undefined) patch[k] = b.extra[k];
    }
    if (Object.keys(patch).length) return c.json(await updateIssue(c, row.key, patch, { loaded, rank }));
    await db.run('UPDATE issues SET rank = ? WHERE id = ?', [rank, row.id]);
    const fresh = await db.get(`${ISSUE_SELECT} WHERE i.id = ?`, [row.id]);
    return c.json({ issue: (await withBlocked(db, c.get('user'), await withLabels(db, [fresh])))[0] });
  });

  app.delete('/api/issues/:key', async (c) => {
    return c.json(await deleteIssue(c, c.req.param('key')));
  });

  registerBulk(app);
  registerChannelAi(app); // channel AI sessions: Apply goes through updateIssue
  registerComments(app);

  // ---- links ----
  app.post('/api/issues/:key/links', async (c) => {
    const { row, db } = await loadIssue(c, c.req.param('key'), 'edit');
    const b = await body(c);
    const type = oneOf(b.type || 'relates', LINK_TYPES, 'Link type');
    const target = await db.get('SELECT id, project_id, key FROM issues WHERE key = ? AND deleted_at IS NULL', [
      String(b.targetKey || '').toUpperCase(),
    ]);
    if (!target) fail(400, 'Issue to link not found');
    await projectAccess(c, target.project_id, 'view');
    if (target.id === row.id) fail(400, 'An issue cannot link to itself');
    const dup = await db.get(
      'SELECT id FROM issue_links WHERE type = ? AND ((source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?))',
      [type, row.id, target.id, target.id, row.id],
    );
    if (dup) fail(409, 'These issues are already linked that way');
    const t = now();
    await db.batch([
      {
        sql: 'INSERT INTO issue_links (id, source_id, target_id, type, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        params: [uuid(), row.id, target.id, type, c.get('user').id, t],
      },
      historyStmt(row.id, c.get('user').id, 'link', null, `${type} ${target.key}`, t, changeSource(c)),
    ]);
    return c.json({ ok: true }, 201);
  });

  app.delete('/api/links/:id', async (c) => {
    const db = c.env.db;
    const l = await db.get('SELECT l.id, i.key FROM issue_links l JOIN issues i ON i.id = l.source_id WHERE l.id = ?', [c.req.param('id')]);
    if (!l) fail(404, 'Link not found');
    await loadIssue(c, l.key, 'edit');
    await db.run('DELETE FROM issue_links WHERE id = ?', [l.id]);
    return c.json({ ok: true });
  });

  // ---- watchers ----
  app.post('/api/issues/:key/watch', async (c) => {
    const { row, db } = await loadIssue(c, c.req.param('key'), 'watch'); // not guest-view
    await db.run('INSERT INTO watchers (issue_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING', [row.id, c.get('user').id]);
    return c.json({ watching: true });
  });

  app.delete('/api/issues/:key/watch', async (c) => {
    const { row, db } = await loadIssue(c, c.req.param('key'));
    await db.run('DELETE FROM watchers WHERE issue_id = ? AND user_id = ?', [row.id, c.get('user').id]);
    return c.json({ watching: false });
  });

  // Add someone else as a watcher (anyone who can edit the issue; the person must be able to see the project).
  app.post('/api/issues/:key/watchers', async (c) => {
    const { row, db } = await loadIssue(c, c.req.param('key'), 'edit');
    const user = c.get('user');
    const b = await body(c);
    const target = await db.get(`SELECT id, name, role FROM users WHERE id = ? AND status <> 'deactivated'`, [String(b.userId || '')]);
    if (!target) fail(400, 'Person not found');
    const project = await db.get('SELECT * FROM projects WHERE id = ?', [row.project_id]);
    if (!(await userCanSee(db, project, target))) fail(400, `${target.name} cannot see this project. Add them as a project member first.`);
    const already = await db.get('SELECT 1 AS x FROM watchers WHERE issue_id = ? AND user_id = ?', [row.id, target.id]);
    if (already) return c.json({ ok: true, added: false });
    await db.batch([
      watchStmt(row.id, target.id),
      ...noticeStmts(
        notices([target.id], {
          type: 'watching',
          issueId: row.id,
          actorId: user.id,
          message: `${user.name} added you as a watcher of ${row.key}: ${row.title}`,
        }),
      ),
    ]);
    return c.json({ ok: true, added: true }, 201);
  });

  app.delete('/api/issues/:key/watchers/:userId', async (c) => {
    const target = c.req.param('userId');
    const self = target === c.get('user').id;
    const { row, db } = await loadIssue(c, c.req.param('key'), self ? 'view' : 'edit');
    await db.run('DELETE FROM watchers WHERE issue_id = ? AND user_id = ?', [row.id, target]);
    return c.json({ ok: true });
  });

  // ---- work log ----
  app.post('/api/issues/:key/worklogs', async (c) => {
    const { row, db, access } = await loadIssue(c, c.req.param('key'), 'edit');
    const b = await body(c);
    const hours = num(b.hours, { name: 'Hours', min: 0.01, max: 24 });
    if (hours === undefined || hours === null) fail(400, 'Hours is required');
    const date = isoDate(b.workDate, 'Date') || (await today(c)); // the workspace day, not the UTC date
    await addWorklog(
      c,
      { row, db, access },
      { hours, note: str(b.note, { max: 2000, name: 'Note' }) || null, date, billable: b.billable !== false },
    );
    return c.json({ ok: true }, 201);
  });

  app.delete('/api/worklogs/:id', async (c) => {
    const db = c.env.db;
    const w = await db.get('SELECT w.id, w.user_id, w.work_date, i.key FROM worklogs w JOIN issues i ON i.id = w.issue_id WHERE w.id = ?', [
      c.req.param('id'),
    ]);
    if (!w) fail(404, 'Work log not found');
    const { access } = await loadIssue(c, w.key, 'view');
    if (w.user_id !== c.get('user').id && !access.canAdmin) fail(403, 'You can only delete your own work log');
    await assertWeeksOpen(db, c.get('user'), [{ userId: w.user_id, date: w.work_date }]); // approved weeks are locked
    await db.run('DELETE FROM worklogs WHERE id = ?', [w.id]);
    return c.json({ ok: true });
  });

  app.get('/api/labels', async (c) => {
    const user = c.get('user');
    const v = visibleProjectsSql(user);
    const q = String(c.req.query('q') || '').toLowerCase();
    const rows = await c.env.db.all(
      `SELECT l.label, CAST(COUNT(*) AS INTEGER) AS n FROM issue_labels l JOIN issues i ON i.id = l.issue_id JOIN projects p ON p.id = i.project_id
        WHERE i.deleted_at IS NULL AND ${v.sql} AND LOWER(l.label) LIKE ? GROUP BY l.label ORDER BY n DESC, l.label LIMIT 50`,
      [...v.params, `%${q}%`],
    );
    return c.json({ labels: rows.map((r) => r.label) });
  });
}
