import { body, fail, str } from '../lib/http.js';
import { hashPassword, verifyPassword, now, uuid } from '../lib/crypto.js';
import { getSettings } from '../lib/settings.js';
import { today as workspaceToday, addDays } from '../lib/time.js';
import { visibleProjectsSql, scopeSql, isGuest, commentVisibleSql, historyVisibleSql, ownedVisibleSql } from '../lib/access.js';
import { checkPassword } from './auth.js';
import { searchIssues } from '../lib/issues/search.js';
import { avatarUrl } from '../lib/avatars.js';
import { audit } from '../lib/audit.js';
import { revokeOtherSessions } from './security.js';
import { placeholders } from '../db/sql.js';

export function registerMe(app) {
  app.get('/api/me', async (c) => {
    const db = c.env.db;
    const u = c.get('user');
    const guest = isGuest(u) ? visibleProjectsSql(u) : null; // as /api/notifications
    const [settings, unread, pw] = await Promise.all([
      getSettings(db),
      db.get(
        `SELECT CAST(COUNT(*) AS INTEGER) AS n FROM notifications n LEFT JOIN issues i ON i.id = n.issue_id
          WHERE n.user_id = ? AND n.read_at IS NULL AND (n.issue_id IS NULL OR i.deleted_at IS NULL)
          ${guest ? `AND EXISTS (SELECT 1 FROM projects p WHERE p.id = COALESCE(i.project_id, n.project_id) AND ${guest.sql})` : ''}`,
        [u.id, ...(guest?.params || [])],
      ),
      db.get('SELECT password_hash, google_sub, avatar_version, totp_enabled_at FROM users WHERE id = ?', [u.id]),
    ]);
    return c.json({
      user: {
        id: u.id,
        email: u.email,
        name: u.name,
        title: u.title,
        role: u.role,
        avatarColor: u.avatar_color,
        avatarUrl: avatarUrl(u.id, pw.avatar_version),
        hasPassword: Boolean(pw.password_hash),
        google: Boolean(pw.google_sub),
        twoFactor: Boolean(pw.totp_enabled_at),
      },
      // an admin who must turn on two-factor first (Admin > Settings > Security): every other request is refused until then
      twoFactorRequired: Boolean(c.get('twoFactorSetupRequired')),
      appName: settings.appName,
      canCreateProject: u.role !== 'viewer' && u.role !== 'guest' && (settings.projectCreation === 'everyone' || u.role === 'admin'),
      demo: Boolean(c.get('demo')), // the public demo account: admin pages are read-only (lib/demo.js)
      guest: u.role === 'guest', // guests: member projects only, no AI connectors, API tokens or Trash
      unreadNotifications: unread.n,
    });
  });

  app.patch('/api/me', async (c) => {
    const b = await body(c);
    const name = str(b.name, { max: 100, name: 'Name' });
    if (name === '' || name === null) fail(400, 'Name is required');
    const title = str(b.title, { max: 100, name: 'Title' });
    const u = c.get('user');
    await c.env.db.run('UPDATE users SET name = ?, title = ?, updated_at = ? WHERE id = ?', [
      name ?? u.name,
      title === undefined ? u.title : title || null,
      now(),
      u.id,
    ]);
    return c.json({ ok: true });
  });

  app.post('/api/me/password', async (c) => {
    const db = c.env.db;
    const b = await body(c);
    const u = await db.get('SELECT id, password_hash FROM users WHERE id = ?', [c.get('user').id]);
    if (u.password_hash && !(await verifyPassword(String(b.currentPassword || ''), u.password_hash)))
      fail(400, 'Current password is wrong');
    checkPassword(b.newPassword);
    // a new password signs out the person's other sessions (this one stays)
    await db.batch([
      { sql: 'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', params: [await hashPassword(b.newPassword), now(), u.id] },
      revokeOtherSessions(c, u.id),
      audit(u.id, 'user.password_changed', 'user', u.id),
    ]);
    return c.json({ ok: true });
  });

  // People picker: everyone who is not deactivated. Guests see only the members of their own projects.
  app.get('/api/users', async (c) => {
    const q = `%${String(c.req.query('q') || '').toLowerCase()}%`;
    const me = c.get('user');
    const peers = isGuest(me)
      ? ` AND id IN (SELECT o.user_id FROM project_members o JOIN project_members mine ON mine.project_id = o.project_id WHERE mine.user_id = ?)`
      : '';
    const rows = await c.env.db.all(
      `SELECT id, name, email, title, role, avatar_color, avatar_version, status FROM users WHERE status <> 'deactivated' AND is_system = 0
         AND (LOWER(name) LIKE ? OR LOWER(email) LIKE ?)${peers} ORDER BY LOWER(name) LIMIT 500`,
      [q, q, ...(peers ? [me.id] : [])],
    );
    return c.json({
      users: rows.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        title: u.title,
        avatarColor: u.avatar_color,
        avatarUrl: avatarUrl(u.id, u.avatar_version),
        invited: u.status === 'invited',
        guest: u.role === 'guest',
      })),
    });
  });

  // ---- notifications ----
  app.get('/api/notifications', async (c) => {
    const scope = scopeSql(c.get('user'), 'i.project_id'); // a project-scoped token sees only those projects' notices
    // Guests: only notices about issues in projects they can still see.
    const guest = isGuest(c.get('user')) ? visibleProjectsSql(c.get('user')) : null;
    const rows = await c.env.db.all(
      `SELECT n.id, n.type, n.message, n.link, n.read_at, n.created_at, i.key AS issue_key, n.actor_id, a.name AS actor_name, a.avatar_color, a.avatar_version
         FROM notifications n LEFT JOIN issues i ON i.id = n.issue_id LEFT JOIN users a ON a.id = n.actor_id
        WHERE n.user_id = ? AND (n.issue_id IS NULL OR i.deleted_at IS NULL)${scope ? ` AND n.issue_id IS NOT NULL AND ${scope.sql}` : ''}
          ${guest ? `AND EXISTS (SELECT 1 FROM projects p WHERE p.id = COALESCE(i.project_id, n.project_id) AND ${guest.sql})` : ''} ORDER BY n.created_at DESC LIMIT 100`,
      [c.get('user').id, ...(scope?.params || []), ...(guest?.params || [])],
    );
    return c.json({
      notifications: rows.map((n) => ({
        id: n.id,
        type: n.type,
        message: n.message,
        read: Boolean(n.read_at),
        createdAt: n.created_at,
        issueKey: n.issue_key,
        link: n.link || null,
        actor: n.actor_name
          ? { name: n.actor_name, avatarColor: n.avatar_color, avatarUrl: avatarUrl(n.actor_id, n.avatar_version) }
          : null,
      })),
    });
  });

  app.post('/api/notifications/read', async (c) => {
    const b = await body(c);
    const uid = c.get('user').id;
    const db = c.env.db;
    if (b.all) await db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', [now(), uid]);
    else if (Array.isArray(b.ids) && b.ids.length) {
      const ids = b.ids.slice(0, 200).map(String);
      await db.run(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND id IN (${placeholders(ids.length)})`, [now(), uid, ...ids]);
    }
    return c.json({ ok: true });
  });

  // ---- saved filters ----
  app.get('/api/filters', async (c) => {
    const v = ownedVisibleSql(c.get('user'), { alias: 'f', shared: 'flag' }); // guests see only their own filters
    const rows = await c.env.db.all(
      `SELECT f.id, f.name, f.query, f.shared, f.owner_id, u.name AS owner_name FROM saved_filters f JOIN users u ON u.id = f.owner_id
        WHERE ${v.sql} ORDER BY LOWER(f.name)`,
      v.params,
    );
    return c.json({
      filters: rows.map((f) => ({
        id: f.id,
        name: f.name,
        query: JSON.parse(f.query),
        shared: Boolean(f.shared),
        ownerName: f.owner_name,
        mine: f.owner_id === c.get('user').id,
      })),
    });
  });

  app.post('/api/filters', async (c) => {
    const b = await body(c);
    const name = str(b.name, { required: true, max: 80, name: 'Name' });
    if (!b.query || typeof b.query !== 'object') fail(400, 'query is required');
    const query = JSON.stringify(b.query);
    if (query.length > 4000) fail(400, 'Filter is too long');
    const id = uuid();
    await c.env.db.run('INSERT INTO saved_filters (id, owner_id, name, query, shared, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      id,
      c.get('user').id,
      name,
      query,
      b.shared && !isGuest(c.get('user')) ? 1 : 0,
      now(),
    ]);
    return c.json({ id }, 201);
  });

  app.delete('/api/filters/:id', async (c) => {
    const r = await c.env.db.run('DELETE FROM saved_filters WHERE id = ? AND owner_id = ?', [c.req.param('id'), c.get('user').id]);
    if (!r.changes) fail(404, 'Filter not found');
    return c.json({ ok: true });
  });

  // ---- home page ----
  app.get('/api/dashboard', async (c) => {
    const db = c.env.db;
    const user = c.get('user');
    const today = await workspaceToday(c);
    const soon = addDays(today, 7);
    const [assigned, reported, watching, due, counts] = await Promise.all([
      searchIssues(db, user, { assignee: 'me', category: 'todo,in_progress', sort: 'priority', limit: 50 }),
      searchIssues(db, user, { reporter: 'me', category: 'todo,in_progress', sort: 'updated', limit: 10 }),
      searchIssues(db, user, { watching: '1', sort: 'updated', limit: 10 }),
      searchIssues(db, user, { assignee: 'me', category: 'todo,in_progress', dueBefore: soon, sort: 'due', limit: 20 }),
      db.all(
        `SELECT s.category, CAST(COUNT(*) AS INTEGER) AS n FROM issues i JOIN statuses s ON s.id = i.status_id JOIN projects p ON p.id = i.project_id
          WHERE i.assignee_id = ? AND i.deleted_at IS NULL AND p.archived = 0 AND ${visibleProjectsSql(user).sql} GROUP BY s.category`,
        [user.id, ...visibleProjectsSql(user).params],
      ),
    ]);
    return c.json({
      assigned: assigned.issues,
      reported: reported.issues,
      watching: watching.issues,
      dueSoon: due.issues.map((i) => ({ ...i, overdue: i.dueDate < today })),
      counts: Object.fromEntries(counts.map((r) => [r.category, r.n])),
    });
  });

  // Activity feed (status changes, edits, comments) across visible projects or one project.
  app.get('/api/activity', async (c) => {
    const db = c.env.db;
    const user = c.get('user');
    const v = visibleProjectsSql(user);
    const project = c.req.query('project');
    const limit = Math.min(Number(c.req.query('limit')) || 50, 200);
    const pf = project ? ' AND p.key = ?' : '';
    const pp = project ? [project.toUpperCase()] : [];
    // filters: type (all | comment | change | status | assignee | created | field name), actor, from/to (dates), before (paging)
    const type = String(c.req.query('type') || 'all');
    const actor = c.req.query('actor') || '';
    const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
    const from = day(c.req.query('from'));
    const to = day(c.req.query('to'));
    const before = String(c.req.query('before') || '');
    const extra = (alias, actorCol) => {
      let sql = '';
      const params = [];
      if (actor) {
        sql += ` AND ${actorCol} = ?`;
        params.push(actor);
      }
      if (from) {
        sql += ` AND ${alias}.created_at >= ?`;
        params.push(`${from}T00:00:00.000Z`);
      }
      if (to) {
        sql += ` AND ${alias}.created_at <= ?`;
        params.push(`${to}T23:59:59.999Z`);
      }
      if (before) {
        sql += ` AND ${alias}.created_at < ?`;
        params.push(before);
      }
      return { sql, params };
    };
    const wantComments = type === 'all' || type === 'comment';
    const wantHistory = type !== 'comment';
    const hx = extra('h', 'h.actor_id');
    let fieldSql = '';
    const fieldParams = [];
    if (wantHistory && type !== 'all' && type !== 'change') {
      fieldSql = ' AND h.field = ?';
      fieldParams.push(type === 'assignee' ? 'assignee' : type);
    }
    const cx = extra('cm', 'cm.author_id');
    const [hist, comments] = await Promise.all([
      wantHistory
        ? db.all(
            `SELECT h.id, h.field, h.old_value, h.new_value, h.created_at, h.actor_id, h.source, u.name, u.avatar_color, u.avatar_version, i.key, i.title
             FROM issue_history h JOIN issues i ON i.id = h.issue_id JOIN projects p ON p.id = i.project_id LEFT JOIN users u ON u.id = h.actor_id
            WHERE i.deleted_at IS NULL AND ${v.sql}${pf}${historyVisibleSql(user)}${fieldSql}${hx.sql} ORDER BY h.created_at DESC LIMIT ?`,
            [...v.params, ...pp, ...fieldParams, ...hx.params, limit],
          )
        : [],
      wantComments
        ? db.all(
            `SELECT cm.id, cm.body, cm.internal, cm.parent_id, cm.created_at, cm.author_id, cm.source, u.name, u.avatar_color, u.avatar_version, i.key, i.title
             FROM comments cm JOIN issues i ON i.id = cm.issue_id JOIN projects p ON p.id = i.project_id LEFT JOIN users u ON u.id = cm.author_id
            WHERE i.deleted_at IS NULL AND cm.deleted_at IS NULL AND ${v.sql}${pf}${commentVisibleSql(user)}${cx.sql} ORDER BY cm.created_at DESC LIMIT ?`,
            [...v.params, ...pp, ...cx.params, limit],
          )
        : [],
    ]);
    const items = [
      ...hist.map((h) => ({
        id: h.id,
        kind: 'change',
        field: h.field,
        from: h.old_value,
        to: h.new_value,
        createdAt: h.created_at,
        viaAi: h.source === 'mcp',
        actor: { name: h.name, avatarColor: h.avatar_color, avatarUrl: avatarUrl(h.actor_id, h.avatar_version) },
        issue: { key: h.key, title: h.title },
      })),
      ...comments.map((x) => ({
        id: x.id,
        kind: 'comment',
        internal: Boolean(Number(x.internal)),
        reply: Boolean(x.parent_id),
        body: x.body.slice(0, 300),
        createdAt: x.created_at,
        viaAi: x.source === 'mcp',
        actor: { name: x.name, avatarColor: x.avatar_color, avatarUrl: avatarUrl(x.author_id, x.avatar_version) },
        issue: { key: x.key, title: x.title },
      })),
    ]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
    // more pages exist when either source filled its limit
    const more = hist.length === limit || comments.length === limit;
    return c.json({ items, more, nextBefore: more && items.length ? items[items.length - 1].createdAt : null });
  });
}
