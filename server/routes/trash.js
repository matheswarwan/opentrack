// The Trash page API. See server/lib/trash.js for how deleting, restoring and purging work.
//   GET    /api/trash?project=KEY&limit=&offset=   items the caller may restore
//   POST   /api/trash/:key/restore                 the reporter (who can still edit the project) or a project admin
//   DELETE /api/trash/:key                         Delete forever: project admins and admins
import { fail } from '../lib/http.js';
import { now } from '../lib/crypto.js';
import { projectAccess, visibleProjectsSql } from '../lib/access.js';
import { getSettings } from '../lib/settings.js';
import { restoreIssue, hardDeleteIssue } from '../lib/trash.js';
import { trashProject, restoreProject, purgeProject } from '../lib/projectTrash.js';
import { requireAdmin } from '../lib/session.js';
import { webhookNotify } from '../lib/webhooks.js';
import { avatarUrl } from '../lib/avatars.js';

/**
 * SQL (+ params) for "can restore": admins everything; otherwise project admins (lead or admin member) and the
 * reporter where they can still edit (member, or an open project they are not a viewer of; not archived).
 * Aliases: i (issues), p (projects).
 */
function restorableSql(user) {
  const v = visibleProjectsSql(user);
  if (user.role === 'admin') return { sql: v.sql, params: v.params, admin: { sql: '1', params: [] } };
  if (user.role === 'viewer' || user.role === 'guest') return { sql: '1 = 0', params: [], admin: { sql: '0', params: [] } }; // guests cannot delete, so they restore nothing
  const member = (role) => `EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.user_id = ? AND m.role = '${role}')`;
  const isAdmin = `(p.lead_id = ? OR ${member('admin')})`;
  const canEdit = `(p.archived = 0 AND (${member('member')} OR (p.visibility = 'open' AND NOT ${member('viewer')})))`;
  return {
    sql: `${v.sql} AND (${isAdmin} OR (i.reporter_id = ? AND ${canEdit}))`,
    params: [...v.params, user.id, user.id, user.id, user.id, user.id],
    admin: { sql: `CASE WHEN ${isAdmin} THEN 1 ELSE 0 END`, params: [user.id, user.id] },
  };
}

async function loadTrashed(c, key) {
  const db = c.env.db;
  const row = await db.get('SELECT * FROM issues WHERE (key = ? OR id = ?) AND deleted_at IS NOT NULL', [String(key).toUpperCase(), key]);
  if (!row) fail(404, 'Not in the Trash');
  const access = await projectAccess(c, row.project_id, 'view');
  return { row, access, db };
}

export function registerTrash(app) {
  app.get('/api/trash', async (c) => {
    const db = c.env.db;
    const user = c.get('user');
    const r = restorableSql(user);
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 100, 1), 200);
    const offset = Math.max(Number(c.req.query('offset')) || 0, 0);
    const project = c.req.query('project');
    const where = `i.deleted_at IS NOT NULL AND i.deleted_with IS NULL AND ${r.sql}${project ? ' AND p.key = ?' : ''}`;
    const params = [...r.params, ...(project ? [String(project).toUpperCase()] : [])];
    const [rows, total, settings] = await Promise.all([
      db.all(
        `SELECT i.id, i.key, i.title, i.type, i.deleted_at, i.reporter_id, p.key AS project_key, p.name AS project_name,
                d.id AS deleted_by_id, d.name AS deleted_by_name, d.avatar_color, d.avatar_version, ${r.admin.sql} AS can_admin,
                (SELECT CAST(COUNT(*) AS INTEGER) FROM issues k WHERE k.deleted_with = i.id) AS subtasks
           FROM issues i JOIN projects p ON p.id = i.project_id LEFT JOIN users d ON d.id = i.deleted_by
          WHERE ${where} ORDER BY i.deleted_at DESC, i.key LIMIT ? OFFSET ?`,
        [...r.admin.params, ...params, limit, offset],
      ),
      db.get(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM issues i JOIN projects p ON p.id = i.project_id WHERE ${where}`, params),
      getSettings(db),
    ]);
    const days = Number(settings.trashDays) || 30;
    return c.json({
      trashDays: days,
      total: total.n,
      limit,
      offset,
      items: rows.map((x) => ({
        key: x.key,
        title: x.title,
        type: x.type,
        project: { key: x.project_key, name: x.project_name },
        deletedAt: x.deleted_at,
        deletedBy: x.deleted_by_id
          ? {
              id: x.deleted_by_id,
              name: x.deleted_by_name,
              avatarColor: x.avatar_color,
              avatarUrl: avatarUrl(x.deleted_by_id, x.avatar_version),
            }
          : null,
        purgeAfter: new Date(Date.parse(x.deleted_at) + days * 864e5).toISOString(),
        subtasks: Number(x.subtasks) || 0,
        canPurge: Boolean(Number(x.can_admin)),
      })),
    });
  });

  app.post('/api/trash/:key/restore', async (c) => {
    const { row, access, db } = await loadTrashed(c, c.req.param('key'));
    const user = c.get('user');
    const reporterCanEdit = access.canEdit && row.reporter_id === user.id;
    if (!access.canAdmin && !reporterCanEdit) fail(403, 'Only the reporter or a project admin can restore this issue');
    const r = await restoreIssue(db, row, user.id, now());
    webhookNotify(c, { event: 'issue.restored', issueId: row.id, projectId: row.project_id }); // outgoing webhooks
    return c.json({ ok: true, key: row.key, ...r });
  });

  app.delete('/api/trash/:key', async (c) => {
    const { row, access } = await loadTrashed(c, c.req.param('key'));
    if (!access.canAdmin) fail(403, 'Only project admins can delete an issue for good');
    if (row.deleted_with) {
      const p = await c.env.db.get('SELECT key FROM issues WHERE id = ?', [row.deleted_with]);
      fail(400, `${row.key} was deleted with ${p?.key || 'its parent'}. Delete that instead.`);
    }
    const r = await hardDeleteIssue(c.env, row, c.get('user').id, now(), 'deleted forever');
    return c.json({ ok: true, key: row.key, ...r });
  });

  // ---- deleted projects (workspace admins) ----
  // The body must name the project key (confirm) so a project is never deleted by a stray call.
  const confirmKey = async (c, project) => {
    const b = await c.req.json().catch(() => ({}));
    if (
      String(b.confirm || '')
        .trim()
        .toUpperCase() !== project.key
    )
      fail(400, `Type the project key ${project.key} to confirm`);
  };
  const loadAnyProject = async (c, key) => {
    const p = await c.env.db.get('SELECT * FROM projects WHERE key = ?', [String(key).toUpperCase()]);
    if (!p) fail(404, 'Project not found');
    return p;
  };

  app.delete('/api/projects/:key', async (c) => {
    requireAdmin(c);
    const project = await loadAnyProject(c, c.req.param('key'));
    await confirmKey(c, project);
    const r = await trashProject(c.env.db, project, c.get('user').id, now());
    const settings = await getSettings(c.env.db);
    return c.json({ ok: true, key: project.key, ...r, trashDays: Number(settings.trashDays) || 30 });
  });

  app.get('/api/project-trash', async (c) => {
    requireAdmin(c);
    const db = c.env.db;
    const [rows, settings] = await Promise.all([
      db.all(
        `SELECT p.id, p.key, p.name, p.deleted_at, d.name AS deleted_by_name,
                (SELECT CAST(COUNT(*) AS INTEGER) FROM issues i WHERE i.project_id = p.id) AS issues
           FROM projects p LEFT JOIN users d ON d.id = p.deleted_by WHERE p.deleted_at IS NOT NULL ORDER BY p.deleted_at DESC`,
      ),
      getSettings(db),
    ]);
    const days = Number(settings.trashDays) || 30;
    return c.json({
      trashDays: days,
      projects: rows.map((x) => ({
        key: x.key,
        name: x.name,
        issues: Number(x.issues) || 0,
        deletedAt: x.deleted_at,
        deletedBy: x.deleted_by_name || null,
        purgeAfter: new Date(Date.parse(x.deleted_at) + days * 864e5).toISOString(),
      })),
    });
  });

  app.post('/api/project-trash/:key/restore', async (c) => {
    requireAdmin(c);
    const project = await loadAnyProject(c, c.req.param('key'));
    await restoreProject(c.env.db, project, c.get('user').id, now());
    return c.json({ ok: true, key: project.key });
  });

  app.delete('/api/project-trash/:key', async (c) => {
    requireAdmin(c);
    const project = await loadAnyProject(c, c.req.param('key'));
    if (!project.deleted_at) fail(400, `Move ${project.key} to the Trash first`);
    await confirmKey(c, project);
    const r = await purgeProject(c.env, project, c.get('user').id, now(), 'deleted forever');
    return c.json({ ok: true, key: project.key, ...r });
  });
}
