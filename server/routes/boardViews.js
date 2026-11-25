// Saved board views: named sets of board filters, private (only the owner) or shared with the project.
//   GET    /api/projects/:key/board-views              views the caller can use, plus their default
//   POST   /api/projects/:key/board-views              { name, shared, filters }
//   PATCH  /api/projects/:key/board-views/:id          { name?, shared?, filters? } owner only
//   DELETE /api/projects/:key/board-views/:id          owner; project admins may also delete shared views
//   PUT    /api/projects/:key/board-views/default      { viewId } or { viewId: null } (remembered per person and project)
// Guests see and save only their own private views. Sharing needs the right to edit issues in the project.
import { body, fail, str } from '../lib/http.js';
import { uuid, now } from '../lib/crypto.js';
import { projectAccess, ownedVisibleSql, canEditOwned } from '../lib/access.js';
import { TYPES as ISSUE_TYPES } from '../lib/issues/model.js';
import { parseJson } from '../lib/json.js';

const MAX_VIEWS = 50; // per person and project
const SCOPES = ['sprint', 'all'];
const LANES = ['none', 'assignee', 'epic'];
const TYPES = ['', ...ISSUE_TYPES];

/** The stored filter set: known keys only, checked and trimmed. */
export function cleanFilters(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) fail(400, 'filters must be an object');
  const text = (v, max, name) => (v === undefined || v === null ? '' : str(v, { max, name }));
  const assignees = Array.isArray(f.assignees) ? f.assignees : [];
  if (assignees.length > 50 || assignees.some((a) => typeof a !== 'string' || a.length > 64))
    fail(400, 'filters.assignees must be a list of user ids');
  return {
    scope: SCOPES.includes(f.scope) ? f.scope : 'all',
    text: text(f.text, 200, 'Filter text'),
    mine: Boolean(f.mine),
    assignees: [...new Set(assignees)],
    type: TYPES.includes(f.type) ? f.type : '',
    label: text(f.label, 100, 'Label'),
    subtasks: Boolean(f.subtasks),
    lanes: LANES.includes(f.lanes) ? f.lanes : 'none',
    oldDone: Boolean(f.oldDone),
  };
}

function viewOut(v, user, access) {
  const filters = parseJson(v.filters, {}); // unreadable: no filters
  const mine = canEditOwned(user, v.owner_id); // the owner only, not workspace admins
  return {
    id: v.id,
    name: v.name,
    shared: Boolean(Number(v.shared)),
    filters,
    owner: { id: v.owner_id, name: v.owner_name || 'Former user' },
    mine,
    canEdit: mine,
    canDelete: mine || (Boolean(Number(v.shared)) && access.canAdmin),
    createdAt: v.created_at,
    updatedAt: v.updated_at,
  };
}

/** Views the caller may use: their own, plus shared ones (not for guests). One bound value: the caller's id. */
function visibleSql(user) {
  return ownedVisibleSql(user, { alias: 'v', shared: 'flag' }).sql;
}

async function loadView(c, access, id) {
  const db = c.env.db;
  const user = c.get('user');
  const v = await db.get(
    `SELECT v.*, u.name AS owner_name FROM board_views v LEFT JOIN users u ON u.id = v.owner_id WHERE v.id = ? AND v.project_id = ? AND ${visibleSql(user)}`,
    [id, access.project.id, user.id],
  );
  if (!v) fail(404, 'Board view not found');
  return v;
}

function canShare(access) {
  return !access.guest && (access.canEdit || access.canAdmin);
}

export function registerBoardViews(app) {
  app.get('/api/projects/:key/board-views', async (c) => {
    const access = await projectAccess(c, c.req.param('key'));
    const db = c.env.db;
    const user = c.get('user');
    const [rows, def] = await Promise.all([
      db.all(
        `SELECT v.*, u.name AS owner_name FROM board_views v LEFT JOIN users u ON u.id = v.owner_id
          WHERE v.project_id = ? AND ${visibleSql(user)} ORDER BY v.shared, LOWER(v.name)`,
        [access.project.id, user.id],
      ),
      db.get('SELECT view_id FROM board_view_defaults WHERE user_id = ? AND project_id = ?', [user.id, access.project.id]),
    ]);
    const views = rows.map((v) => viewOut(v, user, access));
    const defaultId = def && views.some((v) => v.id === def.view_id) ? def.view_id : null; // a view that went private or away counts as none
    return c.json({ views, defaultId, canShare: canShare(access) });
  });

  app.post('/api/projects/:key/board-views', async (c) => {
    const access = await projectAccess(c, c.req.param('key'));
    const db = c.env.db;
    const user = c.get('user');
    const b = await body(c);
    const name = str(b.name, { required: true, max: 80, name: 'Name' });
    const shared = Boolean(b.shared);
    if (shared && !canShare(access))
      fail(403, access.guest ? 'Guests can only save private views' : 'You cannot share views in this project');
    const filters = cleanFilters(b.filters);
    const count = await db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM board_views WHERE project_id = ? AND owner_id = ?', [
      access.project.id,
      user.id,
    ]);
    if (Number(count?.n) >= MAX_VIEWS) fail(400, `You can save at most ${MAX_VIEWS} views per project`);
    const id = uuid();
    const t = now();
    await db.run(
      'INSERT INTO board_views (id, project_id, owner_id, name, shared, filters, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, access.project.id, user.id, name, shared ? 1 : 0, JSON.stringify(filters), t, t],
    );
    if (b.makeDefault) await setDefault(db, user.id, access.project.id, id);
    return c.json({ view: viewOut(await loadView(c, access, id), user, access) }, 201);
  });

  app.put('/api/projects/:key/board-views/default', async (c) => {
    const access = await projectAccess(c, c.req.param('key'));
    const db = c.env.db;
    const user = c.get('user');
    const b = await body(c);
    if (b.viewId === null || b.viewId === undefined || b.viewId === '') {
      await db.run('DELETE FROM board_view_defaults WHERE user_id = ? AND project_id = ?', [user.id, access.project.id]);
      return c.json({ defaultId: null });
    }
    const v = await loadView(c, access, String(b.viewId));
    await setDefault(db, user.id, access.project.id, v.id);
    return c.json({ defaultId: v.id });
  });

  app.patch('/api/projects/:key/board-views/:id', async (c) => {
    const access = await projectAccess(c, c.req.param('key'));
    const db = c.env.db;
    const user = c.get('user');
    const v = await loadView(c, access, c.req.param('id'));
    if (!canEditOwned(user, v.owner_id)) fail(403, 'You can only change your own views');
    const b = await body(c);
    const name = b.name === undefined ? v.name : str(b.name, { required: true, max: 80, name: 'Name' });
    const shared = b.shared === undefined ? Number(v.shared) : b.shared ? 1 : 0;
    if (shared && !Number(v.shared) && !canShare(access))
      fail(403, access.guest ? 'Guests can only save private views' : 'You cannot share views in this project');
    const filters = b.filters === undefined ? v.filters : JSON.stringify(cleanFilters(b.filters));
    await db.run('UPDATE board_views SET name = ?, shared = ?, filters = ?, updated_at = ? WHERE id = ?', [
      name,
      shared,
      filters,
      now(),
      v.id,
    ]);
    return c.json({ view: viewOut(await loadView(c, access, v.id), user, access) });
  });

  app.delete('/api/projects/:key/board-views/:id', async (c) => {
    const access = await projectAccess(c, c.req.param('key'));
    const db = c.env.db;
    const user = c.get('user');
    const v = await loadView(c, access, c.req.param('id'));
    if (!canEditOwned(user, v.owner_id) && !(Number(v.shared) && access.canAdmin)) {
      fail(403, Number(v.shared) ? 'Only the owner or a project admin can delete a shared view' : 'You can only delete your own views');
    }
    await db.batch([
      { sql: 'DELETE FROM board_view_defaults WHERE view_id = ?', params: [v.id] },
      { sql: 'DELETE FROM board_views WHERE id = ?', params: [v.id] },
    ]);
    return c.json({ ok: true });
  });
}

async function setDefault(db, userId, projectId, viewId) {
  await db.run(
    `INSERT INTO board_view_defaults (user_id, project_id, view_id, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, project_id) DO UPDATE SET view_id = excluded.view_id, updated_at = excluded.updated_at`,
    [userId, projectId, viewId, now()],
  );
}
