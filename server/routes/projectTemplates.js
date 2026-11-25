// Project templates: /api/project-templates. Built-ins come from server/lib/projectTemplates.js; saved ones are rows in
// project_templates. Anyone who is not a guest can list the templates they may use (built-ins, their own, shared
// ones); admins can list every saved template with ?all=1. Project admins save a project as a template. The owner or a
// workspace admin can rename, share or delete a saved one. Applying happens in POST /api/projects (templateId).
import { body, fail, str, oneOf } from '../lib/http.js';
import { parseJson } from '../lib/json.js';
import { uuid, now } from '../lib/crypto.js';
import { requireWriter, requireNotGuest } from '../lib/session.js';
import { audit } from '../lib/audit.js';
import { projectAccess, ownedVisibleSql, canEditOwned } from '../lib/access.js';
import { ROLES, MAX_SAVED_PER_USER, MAX_BODY_BYTES, readBody, bodySummary, projectToBody } from '../lib/projectTemplates.js';
import { BUILTINS } from '../lib/projectTemplates/builtins.js';

const builtinCache = new Map();
function builtinBody(t) {
  if (!builtinCache.has(t.id)) builtinCache.set(t.id, readBody(t.body));
  return builtinCache.get(t.id);
}

function savedOut(r, user) {
  let summary = null;
  try {
    summary = bodySummary(readBody(parseJson(r.body)));
  } catch {
    /* a damaged body: listed so it can be deleted */
  }
  return {
    id: r.id,
    name: r.name,
    description: r.description || '',
    builtin: false,
    visibility: r.visibility,
    owner: r.owner_id ? { id: r.owner_id, name: r.owner_name || 'Former user' } : null,
    canEdit: canEditOwned(user, r.owner_id, { admin: true }),
    summary,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const builtinOut = (t) => ({
  id: t.id,
  name: t.name,
  description: t.description,
  builtin: true,
  visibility: 'shared',
  owner: null,
  canEdit: false,
  summary: bodySummary(builtinBody(t)),
});

/** The template a person may start a project from, with its body read and checked. 400 when not found or not allowed. */
export async function templateForUse(db, user, id) {
  const b = BUILTINS.find((t) => t.id === id);
  if (b) return { id: b.id, name: b.name, body: builtinBody(b) };
  const v = ownedVisibleSql(user, { guests: true }); // guests never get here: creating a project refuses them first
  const r = await db.get(`SELECT * FROM project_templates WHERE id = ? AND ${v.sql}`, [String(id), ...v.params]);
  if (!r) fail(400, 'Template not found');
  const raw = parseJson(r.body);
  if (!raw) fail(400, 'This template is damaged and cannot be used');
  return { id: r.id, name: r.name, body: readBody(raw) };
}

const SELECT = 'SELECT t.*, u.name AS owner_name FROM project_templates t LEFT JOIN users u ON u.id = t.owner_id';

export function registerProjectTemplates(app) {
  app.get('/api/project-templates', async (c) => {
    requireNotGuest(c, 'use project templates');
    const user = c.get('user');
    const all = c.req.query('all') === '1' && user.role === 'admin';
    const mine = ownedVisibleSql(user, { alias: 't', guests: true });
    const rows = all
      ? await c.env.db.all(`${SELECT} ORDER BY LOWER(t.name)`)
      : await c.env.db.all(`${SELECT} WHERE ${mine.sql} ORDER BY LOWER(t.name)`, mine.params);
    return c.json({ templates: [...(all ? [] : BUILTINS.map(builtinOut)), ...rows.map((r) => savedOut(r, user))], roles: ROLES });
  });

  // Save a project as a template: { projectKey, name, description, visibility, includeIssues, keepRoles }
  app.post('/api/project-templates', async (c) => {
    requireWriter(c);
    requireNotGuest(c, 'save project templates');
    const db = c.env.db;
    const user = c.get('user');
    const b = await body(c);
    if (!b.projectKey) fail(400, 'projectKey is required');
    const a = await projectAccess(c, b.projectKey, 'admin');
    const name = str(b.name, { max: 80, name: 'Name' }) || `${a.project.name} template`.slice(0, 80);
    const description = str(b.description, { max: 500, name: 'Description' }) || null;
    const visibility = oneOf(b.visibility || 'private', ['private', 'shared'], 'Visibility');
    const n = await db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM project_templates WHERE owner_id = ?', [user.id]);
    if (n.n >= MAX_SAVED_PER_USER) fail(400, `You can keep at most ${MAX_SAVED_PER_USER} saved templates. Delete one first.`);
    const tpl = await projectToBody(db, a.project, { includeIssues: Boolean(b.includeIssues), keepRoles: Boolean(b.keepRoles) });
    const text = JSON.stringify(tpl);
    if (text.length > MAX_BODY_BYTES)
      fail(400, 'This project is too large to save as a template. Leave out the starter issues and try again.');
    const id = uuid();
    const t = now();
    await db.batch([
      {
        sql: 'INSERT INTO project_templates (id, name, description, builtin, owner_id, visibility, body, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)',
        params: [id, name, description, user.id, visibility, text, t, t],
      },
      audit(user.id, 'project_template.created', 'project', a.project.id, {
        id,
        name,
        visibility,
        includeIssues: Boolean(b.includeIssues),
        keepRoles: Boolean(b.keepRoles),
      }),
    ]);
    return c.json({ template: savedOut(await db.get(`${SELECT} WHERE t.id = ?`, [id]), user) }, 201);
  });

  async function loadOwned(c) {
    requireNotGuest(c, 'change project templates');
    const user = c.get('user');
    const id = c.req.param('id');
    if (BUILTINS.some((t) => t.id === id)) fail(400, 'Built-in templates cannot be changed or deleted');
    const r = await c.env.db.get(`${SELECT} WHERE t.id = ?`, [id]);
    if (!r || (r.owner_id !== user.id && r.visibility !== 'shared' && user.role !== 'admin')) fail(404, 'Template not found');
    if (!canEditOwned(user, r.owner_id, { admin: true })) fail(403, 'Only the person who saved this template or an admin can change it');
    return { r, user, db: c.env.db };
  }

  app.patch('/api/project-templates/:id', async (c) => {
    const { r, user, db } = await loadOwned(c);
    const b = await body(c);
    const name = str(b.name, { max: 80, name: 'Name' });
    if (name === '') fail(400, 'Name is required');
    const description = str(b.description, { max: 500, name: 'Description' });
    const visibility = oneOf(b.visibility, ['private', 'shared'], 'Visibility');
    await db.batch([
      {
        sql: 'UPDATE project_templates SET name = ?, description = ?, visibility = ?, updated_at = ? WHERE id = ?',
        params: [name ?? r.name, description === undefined ? r.description : description || null, visibility ?? r.visibility, now(), r.id],
      },
      audit(user.id, 'project_template.updated', 'project_template', r.id, b),
    ]);
    return c.json({ template: savedOut(await db.get(`${SELECT} WHERE t.id = ?`, [r.id]), user) });
  });

  app.delete('/api/project-templates/:id', async (c) => {
    const { r, user, db } = await loadOwned(c);
    await db.batch([
      { sql: 'DELETE FROM project_templates WHERE id = ?', params: [r.id] },
      audit(user.id, 'project_template.deleted', 'project_template', r.id, { name: r.name }),
    ]);
    return c.json({ ok: true });
  });
}
