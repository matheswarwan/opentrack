// Roadmap: epics as bars from start_date to due_date, with their child issues, progress and 'blocks' links.
//   GET /api/roadmap?project=KEY&includeOrphans=1
// project: optional (one key, or several comma separated); without it, every project the caller can see.
// includeOrphans=1 adds stories, tasks and bugs that have no epic.
// Visibility and the Trash come from issueFilter (private projects, token scopes, deleted_at, archived projects).
// A fixed number of queries whatever the size: issues, labels, links and child summaries (one each), using
// the roadmap condition as a subquery instead of long IN lists.
import { issueFilter } from '../lib/issues/search.js';
import { ISSUE_SELECT, issueOut } from '../lib/issues/model.js';
import { notDeleted } from '../db/sql.js';
import { projectAccess, visibleProjectsSql, permissions } from '../lib/access.js';

export const ROADMAP_MAX = 3000; // issues per answer; `truncated` says when there were more

export function registerRoadmap(app) {
  app.get('/api/roadmap', async (c) => {
    const db = c.env.db;
    const user = c.get('user');
    const q = c.req.query();
    const keys = String(q.project || '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    for (const k of keys) await projectAccess(c, k, 'view'); // 404 for a project the caller cannot see
    const orphans = q.includeOrphans === '1';

    const f = issueFilter(user, { project: keys.join(',') });
    // Epics, their stories/tasks/bugs and (optionally) stories/tasks/bugs without a live epic.
    const pick = `(i.type = 'epic' OR (i.type <> 'subtask' AND (pi.type = 'epic'${orphans ? ' OR pi.id IS NULL' : ''})))`;
    const where = `${f.where} AND ${pick}`;
    const idsSql = `SELECT i.id ${f.from} WHERE ${where}`;

    const rows = await db.all(`${ISSUE_SELECT} WHERE ${where} ORDER BY p.key, i.rank, i.created_at LIMIT ?`, [
      ...f.params,
      ROADMAP_MAX + 1,
    ]);
    const truncated = rows.length > ROADMAP_MAX;
    if (truncated) rows.length = ROADMAP_MAX;

    const epicFilter = issueFilter(user, { project: keys.join(','), type: 'epic' });
    const epicIdsSql = `SELECT i.id ${epicFilter.from} WHERE ${epicFilter.where}`;
    const v = visibleProjectsSql(user);
    const [labelRows, links, sums, projectRows] = await Promise.all([
      db.all(`SELECT issue_id, label FROM issue_labels WHERE issue_id IN (${idsSql}) ORDER BY label`, f.params),
      db.all(
        `SELECT s.key AS from_key, t.key AS to_key FROM issue_links l JOIN issues s ON s.id = l.source_id JOIN issues t ON t.id = l.target_id
          WHERE l.type = 'blocks' AND l.source_id IN (${idsSql}) AND l.target_id IN (${idsSql}) ORDER BY l.created_at`,
        [...f.params, ...f.params],
      ),
      // Child summaries of every visible epic (all its live stories/tasks/bugs, whatever the row cap).
      db.all(
        `SELECT c.parent_id, CAST(COUNT(*) AS INTEGER) AS total,
                CAST(SUM(CASE WHEN cs.category = 'done' THEN 1 ELSE 0 END) AS INTEGER) AS done,
                CAST(COUNT(c.story_points) AS INTEGER) AS pointed,
                SUM(COALESCE(c.story_points, 0)) AS points,
                SUM(CASE WHEN cs.category = 'done' THEN COALESCE(c.story_points, 0) ELSE 0 END) AS points_done,
                MIN(COALESCE(c.start_date, c.due_date)) AS min_date,
                MAX(COALESCE(c.due_date, c.start_date)) AS max_date
           FROM issues c JOIN statuses cs ON cs.id = c.status_id
          WHERE ${notDeleted('c')} AND c.type <> 'subtask' AND c.parent_id IN (${epicIdsSql})
          GROUP BY c.parent_id`,
        epicFilter.params,
      ),
      // The caller's rights per project, so the page knows which bars can be dragged.
      db.all(
        `SELECT p.*, m.role AS member_role FROM projects p LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = ?
          WHERE ${v.sql} AND p.archived = 0 ORDER BY p.key`,
        [user.id, ...v.params],
      ),
    ]);

    const labels = new Map();
    for (const l of labelRows) {
      if (!labels.has(l.issue_id)) labels.set(l.issue_id, []);
      labels.get(l.issue_id).push(l.label);
    }
    const out = rows.map((r) => issueOut(r, labels.get(r.id) || []));
    const byId = new Map(out.map((x) => [x.id, x]));
    const sumBy = new Map(sums.map((s) => [s.parent_id, s]));

    const epics = [];
    const orphanList = [];
    for (const x of out) {
      if (x.type === 'epic') {
        epics.push({ ...x, children: [], summary: summary(sumBy.get(x.id)) });
      }
    }
    const epicById = new Map(epics.map((e) => [e.id, e]));
    for (const x of out) {
      if (x.type === 'epic') continue;
      const e = x.parent && epicById.get(x.parent.id);
      if (e) e.children.push(x);
      else if (orphans && (!x.parent || !byId.has(x.parent.id))) orphanList.push(x);
    }
    const used = new Set(out.map((x) => x.projectId));
    const projects = projectRows
      .filter((p) => used.has(p.id))
      .map((p) => ({ key: p.key, name: p.name, canEdit: permissions(user, p, p.member_role).canEdit }));
    return c.json({ epics, orphans: orphanList, links: links.map((l) => ({ from: l.from_key, to: l.to_key })), projects, truncated });
  });
}

function summary(s) {
  const total = Number(s?.total || 0);
  const done = Number(s?.done || 0);
  const points = Number(s?.points || 0);
  const pointsDone = Number(s?.points_done || 0);
  const byPoints = Number(s?.pointed || 0) > 0 && points > 0;
  return {
    total,
    done,
    points,
    pointsDone,
    byPoints,
    progress: byPoints ? pointsDone / points : total ? done / total : 0,
    suggestedStart: s?.min_date || null,
    suggestedDue: s?.max_date || null,
  };
}
