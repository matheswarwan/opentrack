import { body, fail, str, oneOf } from '../lib/http.js';
import { uuid, now } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { projectAccess } from '../lib/access.js';
import { TYPES, PRIORITIES, cleanLabels } from '../lib/issues/model.js';
import { readTemplateFields } from '../lib/customFields.js';
import { resolveIds } from '../lib/releases.js';
import { MAX_SUBTASKS, SUBTASK_PARENTS } from '../lib/issues/templates.js';
import { parseList, parseObject } from '../lib/json.js';

export const MAX_TEMPLATES = 50;
export const STANDARD_TEMPLATES = [
  {
    name: 'Bug report',
    type: 'bug',
    titlePrefix: '[Bug] ',
    priority: 'medium',
    labels: [],
    subtasks: [],
    description:
      '## What happens\n\n\n## Expected\n\n\n## Steps to reproduce\n1. \n2. \n3. \n\n## Environment\n- Browser or device: \n- Account or org: \n- Version: \n',
  },
  {
    name: 'Feature request',
    type: 'story',
    titlePrefix: '[Feature] ',
    priority: 'medium',
    labels: [],
    subtasks: [],
    description: '## Goal\nWho needs this and why.\n\n## Acceptance criteria\n- [ ] \n- [ ] \n- [ ] \n',
  },
  {
    name: 'Task',
    type: 'task',
    titlePrefix: '',
    priority: 'medium',
    labels: [],
    subtasks: [],
    description: '## What to do\n\n\n## Done when\n- [ ] \n- [ ] \n',
  },
];

export const templateOut = (t) => ({
  id: t.id,
  name: t.name,
  type: t.type,
  titlePrefix: t.title_prefix || '',
  description: t.description || '',
  priority: t.priority || null,
  labels: parseList(t.labels),
  subtasks: parseList(t.subtasks),
  fields: parseObject(t.fields),
  components: parseList(t.components), // default component ids
  position: t.position,
  createdAt: t.created_at,
  updatedAt: t.updated_at,
});

/** Validate template fields; `partial` for PATCH (only the fields sent). Returns column values. */
function readTemplate(b, current) {
  const out = {};
  if (!current || b.name !== undefined) {
    out.name = str(b.name, { required: true, max: 80, name: 'Name' });
  }
  if (!current || b.type !== undefined) out.type = oneOf(b.type || 'task', TYPES, 'Type');
  if (b.titlePrefix !== undefined) {
    if (b.titlePrefix !== null && typeof b.titlePrefix !== 'string') fail(400, 'Title prefix must be text');
    const p = (b.titlePrefix || '').replace(/^\s+/, ''); // keep a trailing space: "[Bug] "
    if (p.length > 100) fail(400, 'Title prefix is too long (max 100 characters)');
    out.title_prefix = p || null;
  }
  if (b.description !== undefined) out.description = str(b.description, { max: 50000, name: 'Description' }) || null;
  if (b.priority !== undefined) out.priority = b.priority === null || b.priority === '' ? null : oneOf(b.priority, PRIORITIES, 'Priority');
  if (b.labels !== undefined) out.labels = JSON.stringify(cleanLabels(b.labels || []));
  if (b.subtasks !== undefined) {
    if (b.subtasks !== null && !Array.isArray(b.subtasks)) fail(400, 'subtasks must be a list of titles');
    const list = (b.subtasks || []).map((s) => String(s).trim()).filter(Boolean);
    if (list.length > MAX_SUBTASKS) fail(400, `At most ${MAX_SUBTASKS} sub-tasks`);
    if (list.some((s) => s.length > 255)) fail(400, 'Sub-task titles are at most 255 characters');
    out.subtasks = JSON.stringify(list);
  }
  const type = out.type ?? current?.type ?? 'task';
  const subs = out.subtasks !== undefined ? parseList(out.subtasks) : parseList(current?.subtasks);
  if (subs.length && !SUBTASK_PARENTS.includes(type)) fail(400, 'Only story, task and bug templates can have sub-tasks');
  return out;
}

export function registerTemplates(app) {
  const list = (db, projectId) => db.all('SELECT * FROM issue_templates WHERE project_id = ? ORDER BY position, LOWER(name)', [projectId]);
  const nameTaken = async (db, projectId, name, exceptId = '') =>
    db.get('SELECT id FROM issue_templates WHERE project_id = ? AND LOWER(name) = ? AND id <> ?', [
      projectId,
      name.toLowerCase(),
      exceptId,
    ]);

  app.get('/api/projects/:key/templates', async (c) => {
    const a = await projectAccess(c, c.req.param('key'));
    const live = new Set((await c.env.db.all('SELECT id FROM components WHERE project_id = ?', [a.project.id])).map((r) => r.id));
    const out = (await list(c.env.db, a.project.id)).map(templateOut);
    for (const t of out) t.components = t.components.filter((id) => live.has(id)); // deleted components drop out
    return c.json({ templates: out });
  });

  app.post('/api/projects/:key/templates', async (c) => {
    const a = await projectAccess(c, c.req.param('key'), 'admin');
    const db = c.env.db;
    const b = await body(c);
    const f = readTemplate(b, null);
    if (b.fields !== undefined) f.fields = await readTemplateFields(db, a.project.id, b.fields, f.type); // default custom field values
    if (b.components !== undefined)
      f.components = JSON.stringify((await resolveIds(db, a.project.id, 'components', b.components)).map((r) => r.id)); // default components
    const all = await list(db, a.project.id);
    if (all.length >= MAX_TEMPLATES) fail(400, `A project can have at most ${MAX_TEMPLATES} templates`);
    if (await nameTaken(db, a.project.id, f.name)) fail(409, `A template named "${f.name}" already exists`);
    const id = uuid();
    const t = now();
    await db.batch([
      {
        sql: `INSERT INTO issue_templates (id, project_id, name, type, title_prefix, description, priority, labels, subtasks, fields, components, position, created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          id,
          a.project.id,
          f.name,
          f.type,
          f.title_prefix ?? null,
          f.description ?? null,
          f.priority ?? null,
          f.labels ?? '[]',
          f.subtasks ?? '[]',
          f.fields ?? '{}',
          f.components ?? '[]',
          all.reduce((m, x) => Math.max(m, x.position + 1), 0),
          c.get('user').id,
          t,
          t,
        ],
      },
      audit(c.get('user').id, 'template.created', 'project', a.project.id, { name: f.name }),
    ]);
    return c.json({ template: templateOut(await db.get('SELECT * FROM issue_templates WHERE id = ?', [id])) }, 201);
  });

  // Add the standard set (Bug report, Feature request, Task); names already used are skipped.
  app.post('/api/projects/:key/templates/standard', async (c) => {
    const a = await projectAccess(c, c.req.param('key'), 'admin');
    const db = c.env.db;
    const all = await list(db, a.project.id);
    const used = new Set(all.map((x) => x.name.toLowerCase()));
    const add = STANDARD_TEMPLATES.filter((x) => !used.has(x.name.toLowerCase())).slice(0, Math.max(0, MAX_TEMPLATES - all.length));
    let pos = all.reduce((m, x) => Math.max(m, x.position + 1), 0);
    const t = now();
    if (add.length) {
      await db.batch([
        ...add.map((x) => ({
          sql: `INSERT INTO issue_templates (id, project_id, name, type, title_prefix, description, priority, labels, subtasks, position, created_by, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
            uuid(),
            a.project.id,
            x.name,
            x.type,
            x.titlePrefix || null,
            x.description,
            x.priority,
            JSON.stringify(x.labels),
            JSON.stringify(x.subtasks),
            pos++,
            c.get('user').id,
            t,
            t,
          ],
        })),
        audit(c.get('user').id, 'template.standard_added', 'project', a.project.id, { names: add.map((x) => x.name) }),
      ]);
    }
    return c.json({ added: add.map((x) => x.name), templates: (await list(db, a.project.id)).map(templateOut) });
  });

  async function loadTemplate(c) {
    const a = await projectAccess(c, c.req.param('key'), 'admin');
    const tpl = await c.env.db.get('SELECT * FROM issue_templates WHERE id = ? AND project_id = ?', [c.req.param('id'), a.project.id]);
    if (!tpl) fail(404, 'Template not found');
    return { a, tpl, db: c.env.db };
  }

  app.patch('/api/projects/:key/templates/:id', async (c) => {
    const { a, tpl, db } = await loadTemplate(c);
    const b = await body(c);
    const f = readTemplate(b, tpl);
    if (b.fields !== undefined) f.fields = await readTemplateFields(db, a.project.id, b.fields, f.type || tpl.type);
    if (b.components !== undefined)
      f.components = JSON.stringify((await resolveIds(db, a.project.id, 'components', b.components)).map((r) => r.id));
    if (b.position !== undefined) {
      const p = Number(b.position);
      if (!Number.isInteger(p) || p < 0 || p > 1000) fail(400, 'position must be a whole number');
      f.position = p;
    }
    if (f.name && (await nameTaken(db, a.project.id, f.name, tpl.id))) fail(409, `A template named "${f.name}" already exists`);
    const cols = Object.keys(f);
    if (cols.length) {
      await db.run(`UPDATE issue_templates SET ${[...cols.map((k) => `${k} = ?`), 'updated_at = ?'].join(', ')} WHERE id = ?`, [
        ...cols.map((k) => f[k]),
        now(),
        tpl.id,
      ]);
    }
    return c.json({ template: templateOut(await db.get('SELECT * FROM issue_templates WHERE id = ?', [tpl.id])) });
  });

  app.delete('/api/projects/:key/templates/:id', async (c) => {
    const { a, tpl, db } = await loadTemplate(c);
    await db.batch([
      { sql: 'DELETE FROM issue_templates WHERE id = ?', params: [tpl.id] },
      audit(c.get('user').id, 'template.deleted', 'project', a.project.id, { name: tpl.name }),
    ]);
    return c.json({ ok: true });
  });
}
