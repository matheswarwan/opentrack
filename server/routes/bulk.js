import { body, fail } from '../lib/http.js';
import { requireWriter } from '../lib/session.js';
import { audit } from '../lib/audit.js';
import { visibleProjectsSql } from '../lib/access.js';
import { loadIssue } from '../lib/issues/guards.js';
import { updateIssue, deleteIssue } from '../lib/issues/write.js';
import { cleanLabels } from '../lib/issues/model.js';
import { bulkLists } from '../lib/releases.js';
import { placeholders, inChunks } from '../db/sql.js';

export const BULK_MAX = 500;
// Above this many issues, a bulk change skips the Slack and email hooks (in-app notifications still go out).
export const BULK_QUIET_OVER = 20;

/**
 * POST /api/issues/bulk
 *   { keys: [...], changes: { ...PATCH fields, addLabels: [...], removeLabels: [...],
 *       addComponents, removeComponents, addFixVersions, removeFixVersions: [ids or names] } }
 *   { keys: [...], action: 'delete' | 'watch' | 'unwatch' }   (delete moves issues to the Trash)
 *   optional quiet: true skips the Slack and email hooks (always so above BULK_QUIET_OVER issues)
 * Each issue goes through the same code as PATCH / DELETE /api/issues/:key (permissions, history,
 * notifications). Failures are collected per issue; the call never stops at the first one.
 * `updateIssue` and `deleteIssue` are the ones in lib/issues/write.js.
 */
export function registerBulk(app) {
  app.post('/api/issues/bulk', async (c) => {
    const b = await body(c);
    const user = c.get('user');
    const db = c.env.db;
    if (!Array.isArray(b.keys) || !b.keys.length) fail(400, 'keys must be a list of issue keys');
    const keys = [...new Set(b.keys.map((k) => String(k).trim().toUpperCase()).filter(Boolean))];
    if (keys.length > BULK_MAX) fail(400, `At most ${BULK_MAX} issues at a time`);
    const action = b.action;
    if (action !== undefined && !['delete', 'watch', 'unwatch'].includes(action)) fail(400, 'action must be delete, watch or unwatch');
    if (!action && (!b.changes || typeof b.changes !== 'object' || Array.isArray(b.changes) || !Object.keys(b.changes).length)) {
      fail(400, 'Nothing to change');
    }
    if (action !== 'watch' && action !== 'unwatch') requireWriter(c);

    const changes = action ? null : { ...b.changes };
    const addLabels = changes ? cleanLabels(changes.addLabels) : undefined;
    const removeLabels = changes ? cleanLabels(changes.removeLabels) : undefined;
    // components and fix versions to add or remove (ids or names), turned into full lists per issue
    const relEdits = {};
    for (const k of ['addComponents', 'removeComponents', 'addFixVersions', 'removeFixVersions']) {
      if (!changes || changes[k] === undefined) continue;
      if (!Array.isArray(changes[k]) || changes[k].length > 20) fail(400, `${k} must be a list of at most 20 ids or names`);
      relEdits[k] = changes[k];
      delete changes[k];
    }
    if ((relEdits.addComponents || relEdits.removeComponents) && changes.components !== undefined)
      fail(400, 'Use components or addComponents/removeComponents, not both');
    if ((relEdits.addFixVersions || relEdits.removeFixVersions) && changes.fixVersions !== undefined)
      fail(400, 'Use fixVersions or addFixVersions/removeFixVersions, not both');
    if (changes) {
      delete changes.addLabels;
      delete changes.removeLabels;
      for (const k of ['title', 'description', 'reporterId', 'parentKey', 'parentId', 'type']) {
        if (changes[k] !== undefined) fail(400, `${k} cannot be changed in bulk`);
      }
      if ((addLabels || removeLabels) && changes.labels !== undefined) fail(400, 'Use labels or addLabels/removeLabels, not both');
    }

    // Statuses and sprints belong to one project, so those changes need all issues in one project.
    if (changes && (changes.statusId !== undefined || (changes.sprintId !== undefined && changes.sprintId !== null))) {
      const v = visibleProjectsSql(user); // only issues the caller can see count
      const rows = await inChunks(keys, (part) =>
        db.all(
          `SELECT DISTINCT i.project_id FROM issues i JOIN projects p ON p.id = i.project_id WHERE ${v.sql} AND i.key IN (${placeholders(part.length)})`,
          [...v.params, ...part],
        ),
      );
      if (new Set(rows.map((r) => r.project_id)).size > 1)
        fail(
          400,
          `${changes.statusId !== undefined ? 'Status' : 'Sprint'} can only be changed when all selected issues are in one project`,
        );
    }

    // The web app splits big selections into several calls and sends quiet: true when the whole selection is over the limit.
    const quiet = keys.length > BULK_QUIET_OVER || b.quiet === true;
    // Delete parents before their sub-tasks: a sub-task whose parent is also selected goes to the Trash with that
    // parent (so restoring the parent brings it back) and counts as done here.
    let order = keys;
    const withParent = new Map(); // sub-task key -> parent key, when both are selected
    if (action === 'delete') {
      const subs = await inChunks(keys, (part) =>
        db.all(
          `SELECT i.key, pi.key AS parent_key FROM issues i LEFT JOIN issues pi ON pi.id = i.parent_id
          WHERE i.type = 'subtask' AND i.deleted_at IS NULL AND i.key IN (${placeholders(part.length)})`,
          part,
        ),
      );
      const selected = new Set(keys);
      for (const s of subs) if (s.parent_key && selected.has(s.parent_key)) withParent.set(s.key, s.parent_key);
      const subKeys = new Set(subs.map((s) => s.key));
      order = [...keys.filter((k) => !subKeys.has(k)), ...keys.filter((k) => subKeys.has(k))];
    }

    const results = [];
    const deleted = [];
    for (const key of order) {
      try {
        if (action === 'delete' && withParent.has(key) && deleted.some((d) => d.key === withParent.get(key))) {
          results.push({ key, ok: true }); // went to the Trash with its parent
        } else if (action === 'delete') {
          const r = await deleteIssue(c, key, { audit: false, quiet }); // quiet: no webhook per issue
          deleted.push({ key: r.key, title: r.title, subtasks: r.subtasks });
          results.push({ key, ok: true });
        } else if (action === 'watch' || action === 'unwatch') {
          const { row } = await loadIssue(c, key, action === 'watch' ? 'watch' : 'view'); // guest-view cannot watch
          if (action === 'watch')
            await db.run('INSERT INTO watchers (issue_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING', [row.id, user.id]);
          else await db.run('DELETE FROM watchers WHERE issue_id = ? AND user_id = ?', [row.id, user.id]);
          results.push({ key, ok: true });
        } else {
          const loaded = await loadIssue(c, key, 'edit', { full: true }); // once per key: the list edits below and updateIssue share it
          const { row } = loaded;
          const patch = { ...changes };
          if (addLabels || removeLabels) {
            const cur = (await db.all('SELECT label FROM issue_labels WHERE issue_id = ?', [row.id])).map((r) => r.label);
            const drop = new Set(removeLabels || []);
            patch.labels = [...new Set([...cur, ...(addLabels || [])])].filter((l) => !drop.has(l));
          }
          if (Object.keys(relEdits).length) Object.assign(patch, await bulkLists(db, row, relEdits));
          const r = await updateIssue(c, key, patch, { quiet, loaded });
          results.push({ key, ok: true, changed: r.changed });
        }
      } catch (e) {
        if (!e?.status || e.status >= 500) console.error(e);
        // A hidden project answers 404 "Project not found"; to the caller the issue simply is not there.
        const error =
          e?.status === 404 ? 'Issue not found' : e?.status && e.status < 500 ? e.message : 'Something went wrong on the server';
        results.push({ key, ok: false, error });
      }
    }
    // Back in the order the caller sent.
    const pos = new Map(keys.map((k, i) => [k, i]));
    results.sort((x, y) => pos.get(x.key) - pos.get(y.key));

    const ok = results.filter((r) => r.ok).length;
    const failed = results.length - ok;
    await db.batch([
      audit(user.id, action ? `issue.bulk_${action}` : 'issue.bulk_updated', 'issue', null, {
        count: keys.length,
        ok,
        failed,
        ...(changes
          ? {
              fields: [
                ...Object.keys(changes),
                ...(addLabels ? ['addLabels'] : []),
                ...(removeLabels ? ['removeLabels'] : []),
                ...Object.keys(relEdits),
              ],
              changes: { ...changes, addLabels, removeLabels, ...relEdits },
            }
          : {}),
        ...(action === 'delete' ? { deleted } : { keys: results.filter((r) => r.ok).map((r) => r.key) }),
        ...(failed ? { errors: results.filter((r) => !r.ok).slice(0, 50) } : {}),
      }),
    ]);
    return c.json({ results, updated: ok, skipped: failed, quiet });
  });
}
