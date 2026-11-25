// Issues: loading one with its access check, and the checks on values a write refers to (assignee, parent, sprint).
import { fail } from '../http.js';
import { projectAccess, issueRights, deniedMessage, userCanSee, blindGuests, guestIds } from '../access.js';
import { ISSUE_SELECT, ISSUE_FULL_SELECT, splitFullRow, parentTypeError } from './model.js';
import { notDeleted } from '../../db/sql.js';

/**
 * Load an issue and check the caller may `need` it: view, edit (this issue: guest editors only the ones they
 * reported), delete, or a project right (comment, watch, sprints, create, admin). `rights` holds the issue-level
 * canEdit / canDelete / canComment / canWatch (lib/access.js issueRights).
 * opts.full: also return `current`, the stored issues row (description, the stored parent_id), from the same query,
 * for a write that compares old and new values.
 */
export async function loadIssue(c, key, need = 'view', opts = {}) {
  const db = c.env.db;
  const found = await db.get(`${opts.full ? ISSUE_FULL_SELECT : ISSUE_SELECT} WHERE (i.key = ? OR i.id = ?) AND ${notDeleted('i')}`, [
    String(key).toUpperCase(),
    key,
  ]);
  if (!found) fail(404, 'Issue not found'); // also for issues in the Trash (see /api/trash)
  const { row, current } = opts.full ? splitFullRow(found) : { row: found };
  const issueLevel = need === 'edit' || need === 'delete';
  const access = await projectAccess(c, row.project_id, issueLevel ? 'view' : need);
  const rights = issueRights(access, c.get('user'), row);
  if (need === 'edit' && !rights.canEdit) fail(403, deniedMessage(access.project, access, 'edit'));
  if (need === 'delete') {
    if (access.project.archived) fail(403, 'This project is archived');
    if (!rights.canDelete) {
      fail(
        403,
        access.guest
          ? 'Guests cannot delete issues'
          : access.perms.delete === 'admins'
            ? 'Only project admins can delete issues in this project'
            : 'Only the reporter or a project admin can delete an issue',
      );
    }
  }
  return { row, access, rights, db, ...(opts.full ? { current } : {}) };
}

/** Assignee check: an active user who can see the project (a guest must be a member of it). Returns the id or null. */
export async function checkAssignee(db, project, id) {
  if (id === null || id === undefined || id === '') return null;
  const u = await db.get(`SELECT id, name, role FROM users WHERE id = ? AND status <> 'deactivated' AND is_system = 0`, [id]); // never the AI system user
  if (!u) fail(400, 'Assignee not found');
  if (u.role === 'guest' && !(await userCanSee(db, project, u))) fail(400, `${u.name} is a guest who is not a member of this project`);
  return u.id;
}

/** Leave out of a notification list the people who must not get it: guests who cannot see the project, and all guests for internal notes. */
export async function reachable(db, projectId, ids, { internal = false } = {}) {
  const list = ids.filter(Boolean);
  if (!list.length) return list;
  const drop = internal ? await guestIds(db, list) : await blindGuests(db, projectId, list);
  return list.filter((id) => !drop.has(id));
}

export async function activeUser(db, id, label) {
  if (id === null || id === undefined) return id;
  const u = await db.get(`SELECT id, name FROM users WHERE id = ? AND status <> 'deactivated'`, [id]);
  if (!u) fail(400, `${label} not found`);
  return u.id;
}

/** Check a parent for an issue of `type` in `projectId`; returns the parent id or null. */
export async function checkParent(db, type, parentKey, projectId, selfId) {
  if (type === 'subtask' && !parentKey) fail(400, 'A sub-task needs a parent issue');
  if (!parentKey) return null;
  if (type === 'epic') fail(400, 'An epic cannot have a parent');
  const p = await db.get('SELECT id, type, project_id FROM issues WHERE (key = ? OR id = ?) AND deleted_at IS NULL', [
    String(parentKey).toUpperCase(),
    parentKey,
  ]);
  if (!p) fail(400, 'Parent issue not found');
  if (p.id === selfId) fail(400, 'An issue cannot be its own parent');
  if (p.project_id !== projectId) fail(400, 'The parent must be in the same project');
  const err = parentTypeError(type, p.type);
  if (err) fail(400, err);
  return p.id;
}

export async function checkSprint(db, sprintId, projectId) {
  if (!sprintId) return null;
  const s = await db.get(`SELECT id FROM sprints WHERE id = ? AND project_id = ? AND state <> 'closed'`, [sprintId, projectId]);
  if (!s) fail(400, 'Sprint not found or closed');
  return s.id;
}
