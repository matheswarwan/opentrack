import { fail } from './http.js';
import { placeholders, chunks, notDeleted } from '../db/sql.js';

// ---- Who can do what: the one place for project and issue rights ----
//
// Workspace roles (users.role): admin, member, viewer, guest.
// Project member roles (project_members.role): admin, member, viewer for everyone but guests;
// guest-view, guest-comment, guest-edit for guests only.
//
// Guests (external clients) are denied by default: they see only projects they are a member of (never open
// projects), never internal comments, cannot administer, delete or manage sprints, and can change only the issues
// they reported (guest-edit). Routes ask projectAccess / loadIssue for a right instead of checking roles themselves.

export const MEMBER_ROLES = ['admin', 'member', 'viewer'];
export const GUEST_LEVELS = ['guest-view', 'guest-comment', 'guest-edit'];
export const isGuest = (user) => user?.role === 'guest';

/** Per project permission settings (projects.perm_*); the first value is the default. */
export const PROJECT_PERMS = {
  delete: { col: 'perm_delete', values: ['reporter', 'admins'] },
  sprints: { col: 'perm_sprints', values: ['members', 'admins'] },
  create: { col: 'perm_create', values: ['members', 'admins'] },
  comment: { col: 'perm_comment', values: ['all', 'members'] },
};

export function projectPerms(project) {
  return Object.fromEntries(
    Object.entries(PROJECT_PERMS).map(([k, d]) => [k, d.values.includes(project?.[d.col]) ? project[d.col] : d.values[0]]),
  );
}

/** SQL fragment (+ params) limiting projects to those the user can see. `alias`: the projects table's alias in the caller's query. */
export function visibleProjectsSql(user, alias = 'p') {
  const p = alias;
  const member = `EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = ${p}.id AND m.user_id = ?)`;
  let base;
  if (user.role === 'admin') base = { sql: '1 = 1', params: [] };
  else if (isGuest(user))
    base = { sql: member, params: [user.id] }; // guests: member projects only, never open ones
  else base = { sql: `(${p}.visibility = 'open' OR ${member})`, params: [user.id] };
  base = { sql: `${notDeleted(p)} AND ${base.sql}`, params: base.params }; // projects in the Trash are hidden from everyone
  const scope = scopeSql(user, `${p}.id`);
  return scope ? { sql: `${base.sql} AND ${scope.sql}`, params: [...base.params, ...scope.params] } : base;
}

// ---- Owned plus shared objects: saved reports, dashboards, saved filters, board views, project templates ----
//
// Each row has an owner (owner_id) and is private or shared. The four features differ in details, and each caller
// states its rule through the options below instead of writing the condition again:
//   how "shared" is stored:  reports, dashboards, project templates: visibility = 'shared'; filters, board views: shared = 1
//   guests and shared rows:  never for reports, dashboards, filters and board views; project templates have no
//                            guest rule in the query (their routes refuse guests before it runs)
//   who may change a row:    reports, dashboards, project templates: the owner or a workspace admin;
//                            filters and board views: the owner only (project admins may delete a shared board view)

/**
 * SQL condition (+ params) for the rows the user may see: their own, plus shared ones.
 * opts.alias: the table's alias in the query. opts.shared: 'visibility' (column visibility = 'shared', the default)
 * or 'flag' (column shared = 1). opts.guests: true when a guest also sees shared rows (default: own rows only).
 */
export function ownedVisibleSql(user, { alias = '', shared = 'visibility', guests = false } = {}) {
  const a = alias ? `${alias}.` : '';
  if (isGuest(user) && !guests) return { sql: `${a}owner_id = ?`, params: [user.id] };
  const isShared = shared === 'flag' ? `${a}shared = 1` : `${a}visibility = 'shared'`;
  return { sql: `(${a}owner_id = ? OR ${isShared})`, params: [user.id] };
}

/** May the user change or delete an owned object: its owner, and with opts.admin also a workspace admin. */
export function canEditOwned(user, ownerId, { admin = false } = {}) {
  return ownerId === user.id || (admin && user.role === 'admin');
}

/** SQL condition (starting with AND) that hides internal comments from guests; '' for everyone else. */
export function commentVisibleSql(user, alias = 'cm') {
  return isGuest(user) ? ` AND ${alias}.internal = 0` : '';
}

/** History fields about internal content, never shown to guests. */
export const INTERNAL_HISTORY_FIELDS = ['internal_attachment'];

/** SQL condition (starting with AND) that hides history rows about internal content from guests. */
export function historyVisibleSql(user, alias = 'h') {
  return isGuest(user) ? ` AND ${alias}.field NOT IN (${INTERNAL_HISTORY_FIELDS.map((f) => `'${f}'`).join(', ')})` : '';
}

/** SQL condition (starting with AND) that hides internal-note files from guests. */
export function attachmentVisibleSql(user, alias = 'a') {
  return isGuest(user) ? ` AND ${alias}.internal = 0` : '';
}

/**
 * A personal API token limited to some projects (user.projectScope, set by tokenUser) sees only those.
 * Returns an SQL condition on `col` (a project id column), or null when the caller is not limited.
 */
export function scopeSql(user, col) {
  const scope = user.projectScope;
  if (!Array.isArray(scope)) return null;
  if (!scope.length) return { sql: '1 = 0', params: [] };
  return { sql: `${col} IN (${placeholders(scope.length)})`, params: [...scope] };
}

export function inScope(user, projectId) {
  return !Array.isArray(user.projectScope) || user.projectScope.includes(projectId);
}

/**
 * The caller's rights in a project. memberRole: their project_members.role (or null).
 *   canView, canEdit (edit any issue), canAdmin (project settings), canCreate, canComment, canWatch,
 *   canSprints (manage sprints, move issues between sprints), canEditOwn (guest-edit: issues they reported),
 *   canDeleteOwn (delete issues they reported), guest, perms (the project's permission settings).
 */
export function permissions(user, project, memberRole) {
  const perms = projectPerms(project);
  if (isGuest(user)) {
    const level = !memberRole ? null : GUEST_LEVELS.includes(memberRole) ? memberRole : 'guest-view';
    const live = Boolean(level) && !project.archived;
    const canEditOwn = live && level === 'guest-edit';
    return {
      canView: Boolean(level),
      canEdit: false,
      canAdmin: false,
      memberRole: level,
      guest: true,
      canEditOwn,
      canCreate: canEditOwn && perms.create === 'members',
      canComment: live && level !== 'guest-view' && perms.comment === 'all',
      canWatch: Boolean(level) && level !== 'guest-view',
      canSprints: false,
      canDeleteOwn: false,
      perms,
    };
  }
  // A guest level left on someone who is no longer a guest counts as viewer (read only).
  const role = GUEST_LEVELS.includes(memberRole) ? 'viewer' : memberRole;
  const admin = user.role === 'admin';
  const canView = admin || project.visibility === 'open' || Boolean(role);
  const writer = user.role !== 'viewer';
  const canAdmin = admin || (writer && (role === 'admin' || project.lead_id === user.id));
  const canEditAny =
    canAdmin || (writer && !project.archived && (role === 'member' || (project.visibility === 'open' && role !== 'viewer')));
  const canEdit = canEditAny && !project.archived;
  return {
    canView,
    canEdit,
    canAdmin,
    memberRole: memberRole || null,
    guest: false,
    canEditOwn: false,
    canCreate: canEdit && (canAdmin || perms.create === 'members'),
    canComment: canEdit,
    canWatch: canView,
    canSprints: canEdit && (canAdmin || perms.sprints === 'members'),
    canDeleteOwn: canEdit && perms.delete === 'reporter',
    perms,
  };
}

/** Rights on one issue (row needs reporter_id), from the project rights. */
export function issueRights(access, user, row) {
  const own = Boolean(row.reporter_id) && row.reporter_id === user.id;
  return {
    canEdit: access.canEdit || (access.canEditOwn && own),
    canDelete: access.canAdmin || (access.canDeleteOwn && own),
    canComment: access.canComment,
    canWatch: access.canWatch,
  };
}

const NEED_FLAG = {
  edit: 'canEdit',
  admin: 'canAdmin',
  create: 'canCreate',
  sprints: 'canSprints',
  comment: 'canComment',
  watch: 'canWatch',
};

/** Why `need` was refused (the 403 text). */
export function deniedMessage(project, perms, need) {
  if (project.archived && need !== 'admin' && need !== 'watch') return 'This project is archived';
  if (need === 'admin') return 'Only project admins can do this';
  if (perms.guest) {
    if (need === 'create' && perms.canEditOwn) return 'Only project admins can create issues in this project';
    if (need === 'comment' && perms.memberRole !== 'guest-view') return 'Only team members can comment in this project';
    if (need === 'edit' && perms.canEditOwn) return 'You can only change issues you reported';
    return 'Your guest access does not allow this';
  }
  if (need === 'create' && perms.canEdit) return 'Only project admins can create issues in this project';
  if (need === 'sprints' && perms.canEdit) return 'Only project admins can manage sprints in this project';
  if (need === 'comment' || need === 'create' || need === 'sprints' || need === 'edit') return 'You cannot change issues in this project';
  return 'Not allowed';
}

/** Load a project by key or id and the caller's rights; 404s when it is not visible. need: view, edit, admin, create, sprints, comment, watch. */
export async function projectAccess(c, keyOrId, need = 'view') {
  const db = c.env.db;
  const user = c.get('user');
  const project = await db.get('SELECT * FROM projects WHERE key = ? OR id = ?', [String(keyOrId).toUpperCase(), keyOrId]);
  if (!project || project.deleted_at || !inScope(user, project.id)) fail(404, 'Project not found'); // deleted: in the Trash
  const m = await db.get('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?', [project.id, user.id]);
  const perms = permissions(user, project, m?.role);
  if (!perms.canView) fail(404, 'Project not found');
  if (need !== 'view' && !perms[NEED_FLAG[need] || 'none']) fail(403, deniedMessage(project, perms, need));
  return { project, ...perms };
}

/**
 * Can this person (a users row with id and role) see the project? Checked before assigning, adding a watcher or
 * notifying someone, so a guest is never pointed at a project they are not a member of.
 */
export async function userCanSee(db, project, person) {
  if (!person) return false;
  if (person.role === 'admin') return true;
  const m = await db.get('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?', [project.id, person.id]);
  return permissions(person, project, m?.role).canView;
}

/** Of these user ids, the ones that are guests (left out of notifications about internal notes). */
export async function guestIds(db, ids) {
  const list = [...new Set(ids.filter(Boolean))];
  const out = new Set();
  for (const part of chunks(list)) {
    const rows = await db.all(`SELECT id FROM users WHERE role = 'guest' AND id IN (${placeholders(part.length)})`, part);
    for (const r of rows) out.add(r.id);
  }
  return out;
}

/** Of these user ids, the ones that cannot see the project (guests who are not members), for notification filtering. */
export async function blindGuests(db, projectId, ids) {
  const guests = [...(await guestIds(db, ids))];
  if (!guests.length) return new Set();
  const members = new Set(
    (
      await db.all(`SELECT user_id FROM project_members WHERE project_id = ? AND user_id IN (${placeholders(guests.length)})`, [
        projectId,
        ...guests,
      ])
    ).map((r) => r.user_id),
  );
  return new Set(guests.filter((g) => !members.has(g)));
}
