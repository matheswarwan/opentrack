// Deleting a project (workspace admins, feedback 2026-11-20): the project goes to the Trash. It is hidden from
// every list, search, report and job (visibleProjectsSql and projectAccess skip deleted_at; it is also archived
// meanwhile, which recurring rules, capacity and digests already skip). Admins restore it from the Trash for
// trashDays (setting), or delete it forever; the trash_purge job removes it after that. Removing the projects row
// cascades to everything in it (statuses, sprints, issues and their comments, history, files, ...); attachment bytes
// kept outside the database (R2/GCS) are deleted through files.js. The key stays taken while it is in the Trash.
import { audit } from './audit.js';
import { deleteExternal } from './files.js';
import { fail } from './http.js';

async function counts(db, projectId) {
  const r = await db.get(
    `SELECT (SELECT CAST(COUNT(*) AS INTEGER) FROM issues WHERE project_id = ?) AS issues,
            (SELECT CAST(COUNT(*) AS INTEGER) FROM attachments a JOIN issues i ON i.id = a.issue_id WHERE i.project_id = ?) AS files`,
    [projectId, projectId],
  );
  return { issues: Number(r?.issues) || 0, files: Number(r?.files) || 0 };
}

/** Move a project to the Trash. */
export async function trashProject(db, project, actorId, t) {
  if (project.deleted_at) fail(400, `${project.key} is already in the Trash`);
  const n = await counts(db, project.id);
  await db.batch([
    {
      sql: 'UPDATE projects SET deleted_at = ?, deleted_by = ?, deleted_archived = archived, archived = 1, updated_at = ? WHERE id = ?',
      params: [t, actorId, t, project.id],
    },
    audit(actorId, 'project.trashed', 'project', project.id, { key: project.key, name: project.name, ...n }, t),
  ]);
  return n;
}

/** Bring a project back from the Trash, with its archived flag from before. */
export async function restoreProject(db, project, actorId, t) {
  if (!project.deleted_at) fail(400, `${project.key} is not in the Trash`);
  await db.batch([
    {
      sql: 'UPDATE projects SET archived = COALESCE(deleted_archived, 0), deleted_at = NULL, deleted_by = NULL, deleted_archived = NULL, updated_at = ? WHERE id = ?',
      params: [t, project.id],
    },
    audit(actorId, 'project.restored', 'project', project.id, { key: project.key, name: project.name }, t),
  ]);
}

/** Remove a project and everything in it for good. */
export async function purgeProject(env, project, actorId, t, reason) {
  const db = env.db;
  const n = await counts(db, project.id);
  const external = await db.all(
    `SELECT a.id, a.storage FROM attachments a JOIN issues i ON i.id = a.issue_id WHERE i.project_id = ? AND a.storage <> 'db'`,
    [project.id],
  );
  await db.batch([
    // links from other projects' issues to this project's issues cascade with the issues
    { sql: 'UPDATE issues SET parent_id = NULL WHERE project_id = ? AND parent_id IS NOT NULL', params: [project.id] },
    { sql: 'DELETE FROM issues WHERE project_id = ?', params: [project.id] },
    { sql: 'DELETE FROM projects WHERE id = ?', params: [project.id] },
    audit(
      actorId,
      'project.purged',
      'project',
      project.id,
      { key: project.key, name: project.name, reason, deletedAt: project.deleted_at || null, ...n },
      t,
    ),
  ]);
  await deleteExternal(env, external);
  return { ...n, external: external.length };
}

/** Projects in the Trash longer than the cutoff, oldest first. */
export function expiredProjects(db, cutoffIso, limit) {
  return db.all('SELECT * FROM projects WHERE deleted_at IS NOT NULL AND deleted_at < ? ORDER BY deleted_at, id LIMIT ?', [
    cutoffIso,
    limit,
  ]);
}
