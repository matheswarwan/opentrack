// Issue links: blocked flags for lists, an epic's dependency view, and the notices sent when a blocker is done.
import { visibleProjectsSql, guestIds } from '../access.js';
import { notices } from '../notifications.js';
import { placeholders, chunks, notDeleted } from '../../db/sql.js';

// An issue is blocked while another issue 'blocks' it (link source -> target) and that blocker is not done and not
// in the Trash. List payloads get blocked, blockedBy (blocker keys the viewer can see) and blockedHidden (blockers in
// projects the viewer cannot see: counted, never named). One query per 80 issues.
export const OPEN_BLOCKER_SQL = `FROM issue_links bl JOIN issues bi ON bi.id = bl.source_id JOIN statuses bs ON bs.id = bi.status_id
  WHERE bl.type = 'blocks' AND bi.deleted_at IS NULL AND bs.category <> 'done'`;

export async function withBlocked(db, user, issues) {
  if (!issues.length) return issues;
  const v = visibleProjectsSql(user);
  const size = Math.max(1, Math.min(80, 95 - v.params.length)); // D1 allows at most 100 bound values per query
  const map = new Map();
  for (const part of chunks(issues, size)) {
    const ids = part.map((x) => x.id);
    const rows = await db.all(
      `SELECT bl.target_id, bi.key, CASE WHEN ${v.sql} THEN 1 ELSE 0 END AS visible
         ${OPEN_BLOCKER_SQL.replace('JOIN statuses bs', 'JOIN projects p ON p.id = bi.project_id JOIN statuses bs')} AND bl.target_id IN (${placeholders(ids.length)})
        ORDER BY bi.project_id, bi.number`,
      [...v.params, ...ids],
    );
    for (const r of rows) {
      if (!map.has(r.target_id)) map.set(r.target_id, { keys: [], hidden: 0 });
      const m = map.get(r.target_id);
      if (Number(r.visible)) m.keys.push(r.key);
      else m.hidden += 1;
    }
  }
  for (const x of issues) {
    const m = map.get(x.id);
    x.blocked = Boolean(m);
    x.blockedBy = m ? m.keys : [];
    x.blockedHidden = m ? m.hidden : 0;
  }
  return issues;
}

/**
 * Notices (lib/notifications.js) for the assignees of issues this one was the last open blocker of (it is moving to done):
 * "WEB-3 is done; WEB-9 is no longer blocked". The blocker's key is left out when the blocked issue is in another
 * project and the blocker's project is members-only.
 */
export async function unblockNotices(db, current, actor) {
  const rows = await db.all(
    `SELECT t.id, t.key, t.project_id, t.assignee_id FROM issue_links l JOIN issues t ON t.id = l.target_id JOIN statuses ts ON ts.id = t.status_id
      WHERE l.source_id = ? AND l.type = 'blocks' AND t.deleted_at IS NULL AND ts.category <> 'done' AND t.assignee_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 ${OPEN_BLOCKER_SQL} AND bl.target_id = t.id AND bl.source_id <> ?)`,
    [current.id, current.id],
  );
  if (!rows.length) return [];
  const project = await db.get('SELECT visibility FROM projects WHERE id = ?', [current.project_id]);
  const guests = await guestIds(
    db,
    rows.map((r) => r.assignee_id),
  ); // guests never see open projects they are not in
  const out = [];
  for (const r of rows) {
    const named = r.project_id === current.project_id || (project?.visibility === 'open' && !guests.has(r.assignee_id));
    const message = named
      ? `${current.key} is done; ${r.key} is no longer blocked`
      : `A blocking issue is done; ${r.key} is no longer blocked`;
    out.push(...notices([r.assignee_id], { type: 'unblocked', issueId: r.id, actorId: actor.id, message }));
  }
  return out;
}

/**
 * An epic's dependency view: every 'blocks' link that touches one of its children. The other end is named only when
 * the viewer can see its project. Returns [{ from, to }] where each end is { key, title, status, child } or { hidden: true }.
 */
export async function epicDependencies(db, user, children) {
  if (!children.length) return [];
  const v = visibleProjectsSql(user, 'sp'); // the source's project; the target's (tp) takes the same params
  const vt = visibleProjectsSql(user, 'tp');
  const childIds = new Set(children.map((x) => x.id));
  const size = Math.max(1, Math.min(40, Math.floor((95 - v.params.length * 2) / 2)));
  const seen = new Set();
  const out = [];
  const end = (id, key, title, statusName, category, visible) =>
    visible ? { key, title, status: { name: statusName, category }, child: childIds.has(id) } : { hidden: true };
  for (const part of chunks(children, size)) {
    const ids = part.map((x) => x.id);
    const ph = placeholders(ids.length);
    const rows = await db.all(
      `SELECT l.id, s.id AS s_id, s.key AS s_key, s.title AS s_title, ss.name AS s_status, ss.category AS s_cat,
              t.id AS t_id, t.key AS t_key, t.title AS t_title, ts.name AS t_status, ts.category AS t_cat,
              CASE WHEN ${v.sql} THEN 1 ELSE 0 END AS s_visible,
              CASE WHEN ${vt.sql} THEN 1 ELSE 0 END AS t_visible
         FROM issue_links l
         JOIN issues s ON s.id = l.source_id JOIN statuses ss ON ss.id = s.status_id JOIN projects sp ON sp.id = s.project_id
         JOIN issues t ON t.id = l.target_id JOIN statuses ts ON ts.id = t.status_id JOIN projects tp ON tp.id = t.project_id
        WHERE l.type = 'blocks' AND ${notDeleted('s')} AND ${notDeleted('t')} AND (l.source_id IN (${ph}) OR l.target_id IN (${ph}))
        ORDER BY l.created_at`,
      [...v.params, ...vt.params, ...ids, ...ids],
    );
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({
        from: end(r.s_id, r.s_key, r.s_title, r.s_status, r.s_cat, Number(r.s_visible)),
        to: end(r.t_id, r.t_key, r.t_title, r.t_status, r.t_cat, Number(r.t_visible)),
      });
    }
  }
  return out;
}
