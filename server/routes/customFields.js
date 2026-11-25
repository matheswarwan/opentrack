// Project settings > Fields: custom field definitions (server/lib/customFields.js has the value rules).
// Everyone who can see the project can list its fields; only project admins change them.
import { body, fail } from '../lib/http.js';
import { uuid, now } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { projectAccess } from '../lib/access.js';
import { fieldOut, listFields, readDefinition, MAX_FIELDS } from '../lib/customFields.js';

export function registerCustomFields(app) {
  const nameTaken = (db, projectId, name, exceptId = '') =>
    db.get('SELECT id FROM custom_fields WHERE project_id = ? AND LOWER(name) = ? AND id <> ?', [projectId, name.toLowerCase(), exceptId]);

  app.get('/api/projects/:key/fields', async (c) => {
    const a = await projectAccess(c, c.req.param('key'));
    return c.json({ fields: await listFields(c.env.db, a.project.id) });
  });

  app.post('/api/projects/:key/fields', async (c) => {
    const a = await projectAccess(c, c.req.param('key'), 'admin');
    const db = c.env.db;
    const f = readDefinition(await body(c), null, uuid);
    const all = await listFields(db, a.project.id);
    if (all.length >= MAX_FIELDS) fail(400, `A project can have at most ${MAX_FIELDS} fields`);
    if (await nameTaken(db, a.project.id, f.name)) fail(409, `A field named "${f.name}" already exists`);
    const id = uuid();
    const t = now();
    await db.batch([
      {
        sql: `INSERT INTO custom_fields (id, project_id, name, type, options, required, help, issue_types, position, archived, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          id,
          a.project.id,
          f.name,
          f.type,
          f.options ?? '[]',
          f.required ?? 0,
          f.help ?? null,
          f.issue_types ?? '[]',
          f.position ?? all.reduce((m, x) => Math.max(m, x.position + 1), 0),
          f.archived ?? 0,
          t,
          t,
        ],
      },
      audit(c.get('user').id, 'field.created', 'project', a.project.id, { name: f.name, type: f.type }),
    ]);
    return c.json({ field: fieldOut(await db.get('SELECT * FROM custom_fields WHERE id = ?', [id])) }, 201);
  });

  async function loadField(c) {
    const a = await projectAccess(c, c.req.param('key'), 'admin');
    const field = await c.env.db.get('SELECT * FROM custom_fields WHERE id = ? AND project_id = ?', [c.req.param('id'), a.project.id]);
    if (!field) fail(404, 'Field not found');
    return { a, field, db: c.env.db };
  }

  // Change name, help, required, issue types, position, archived, or options (add, rename, reorder, archive).
  app.patch('/api/projects/:key/fields/:id', async (c) => {
    const { a, field, db } = await loadField(c);
    const f = readDefinition(await body(c), field, uuid);
    if (f.name && (await nameTaken(db, a.project.id, f.name, field.id))) fail(409, `A field named "${f.name}" already exists`);
    const cols = Object.keys(f);
    if (cols.length) {
      await db.batch([
        {
          sql: `UPDATE custom_fields SET ${[...cols.map((k) => `${k} = ?`), 'updated_at = ?'].join(', ')} WHERE id = ?`,
          params: [...cols.map((k) => f[k]), now(), field.id],
        },
        audit(c.get('user').id, 'field.updated', 'project', a.project.id, { name: f.name || field.name, fields: cols }),
      ]);
    }
    return c.json({ field: fieldOut(await db.get('SELECT * FROM custom_fields WHERE id = ?', [field.id])) });
  });

  // Delete a field and every value it holds (archive it instead to keep the values).
  app.delete('/api/projects/:key/fields/:id', async (c) => {
    const { a, field, db } = await loadField(c);
    const n = await db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM issue_field_values WHERE field_id = ?', [field.id]);
    await db.batch([
      { sql: 'DELETE FROM issue_field_values WHERE field_id = ?', params: [field.id] },
      { sql: 'DELETE FROM custom_fields WHERE id = ?', params: [field.id] },
      audit(c.get('user').id, 'field.deleted', 'project', a.project.id, { name: field.name, values: n.n }),
    ]);
    return c.json({ ok: true, values: n.n });
  });
}
