// Components (Project settings > Components) and releases (the project's Releases tab), like Jira's components and
// versions. Everyone who can see a project can list them; only project admins change them. Members put issues in
// components and fix versions through the issue API (server/lib/releases.js has the shared rules).
import { body, fail, str, isoDate } from '../lib/http.js';
import { uuid, now } from '../lib/crypto.js';
import { today } from '../lib/time.js';
import { changeSource } from '../lib/history.js';
import { audit } from '../lib/audit.js';
import { projectAccess } from '../lib/access.js';
import { webhookNotify } from '../lib/webhooks.js';
import { searchIssues } from '../lib/issues/search.js';
import { publicOrigin } from '../lib/http.js';
import {
  componentOut,
  releaseOut,
  listComponents,
  listReleases,
  releaseProgress,
  withReleases,
  releaseNotes,
  notesFilename,
  historyStmts,
  MAX_COMPONENTS,
  MAX_RELEASES,
} from '../lib/releases.js';
import { placeholders, chunks } from '../db/sql.js';

const RELEASE_PAGE_MAX = 1000;

export function registerReleases(app) {
  // ---------- components ----------

  const componentRow = (db, id) =>
    db.get(
      `SELECT c.*, l.name AS lead_name, d.name AS default_name FROM components c
       LEFT JOIN users l ON l.id = c.lead_id LEFT JOIN users d ON d.id = c.default_assignee_id WHERE c.id = ?`,
      [id],
    );

  /** An active person who can see the project (lead or default assignee), or null. */
  async function checkPerson(db, project, id, label) {
    if (id === undefined) return undefined;
    if (id === null || id === '') return null;
    const u = await db.get(`SELECT id, name, role FROM users WHERE id = ? AND status <> 'deactivated'`, [String(id)]);
    if (!u) fail(400, `${label} not found`);
    if (u.role !== 'admin' && project.visibility !== 'open') {
      const m = await db.get('SELECT 1 AS x FROM project_members WHERE project_id = ? AND user_id = ?', [project.id, u.id]);
      if (!m) fail(400, `${u.name} cannot see this project. Add them as a project member first.`);
    }
    return u.id;
  }

  async function readComponent(db, project, b, current) {
    const out = {};
    if (!current || b.name !== undefined) {
      const name = str(b.name, { required: true, max: 80, name: 'Name' });
      const taken = await db.get('SELECT id FROM components WHERE project_id = ? AND LOWER(name) = ? AND id <> ?', [
        project.id,
        name.toLowerCase(),
        current?.id || '',
      ]);
      if (taken) fail(409, `A component named "${name}" already exists`);
      out.name = name;
    }
    if (b.description !== undefined) out.description = str(b.description, { max: 1000, name: 'Description' }) || null;
    const lead = await checkPerson(db, project, b.leadId, 'Lead');
    if (lead !== undefined) out.lead_id = lead;
    const def = await checkPerson(db, project, b.defaultAssigneeId, 'Default assignee');
    if (def !== undefined) out.default_assignee_id = def;
    return out;
  }

  app.get('/api/projects/:key/components', async (c) => {
    const a = await projectAccess(c, c.req.param('key'));
    const db = c.env.db;
    const [rows, counts] = await Promise.all([
      listComponents(db, a.project.id),
      db.all(
        `SELECT ic.component_id, CAST(COUNT(*) AS INTEGER) AS n, CAST(SUM(CASE WHEN s.category = 'done' THEN 0 ELSE 1 END) AS INTEGER) AS open
           FROM issue_components ic JOIN components c ON c.id = ic.component_id JOIN issues i ON i.id = ic.issue_id JOIN statuses s ON s.id = i.status_id
          WHERE c.project_id = ? AND i.deleted_at IS NULL GROUP BY ic.component_id`,
        [a.project.id],
      ),
    ]);
    const n = new Map(counts.map((r) => [r.component_id, r]));
    return c.json({
      components: rows.map((r) => componentOut(r, { issues: Number(n.get(r.id)?.n || 0), openIssues: Number(n.get(r.id)?.open || 0) })),
      canAdmin: a.canAdmin,
    });
  });

  app.post('/api/projects/:key/components', async (c) => {
    const a = await projectAccess(c, c.req.param('key'), 'admin');
    const db = c.env.db;
    const f = await readComponent(db, a.project, await body(c), null);
    const count = await db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM components WHERE project_id = ?', [a.project.id]);
    if (count.n >= MAX_COMPONENTS) fail(400, `A project can have at most ${MAX_COMPONENTS} components`);
    const id = uuid();
    const t = now();
    await db.batch([
      {
        sql: 'INSERT INTO components (id, project_id, name, description, lead_id, default_assignee_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        params: [id, a.project.id, f.name, f.description ?? null, f.lead_id ?? null, f.default_assignee_id ?? null, t, t],
      },
      audit(c.get('user').id, 'component.created', 'project', a.project.id, { name: f.name }),
    ]);
    return c.json({ component: componentOut(await componentRow(db, id), { issues: 0, openIssues: 0 }) }, 201);
  });

  async function loadComponent(c) {
    const a = await projectAccess(c, c.req.param('key'), 'admin');
    const row = await c.env.db.get('SELECT * FROM components WHERE id = ? AND project_id = ?', [c.req.param('id'), a.project.id]);
    if (!row) fail(404, 'Component not found');
    return { a, row, db: c.env.db };
  }

  app.patch('/api/projects/:key/components/:id', async (c) => {
    const { a, row, db } = await loadComponent(c);
    const f = await readComponent(db, a.project, await body(c), row);
    const cols = Object.keys(f);
    if (cols.length) {
      await db.batch([
        {
          sql: `UPDATE components SET ${[...cols.map((k) => `${k} = ?`), 'updated_at = ?'].join(', ')} WHERE id = ?`,
          params: [...cols.map((k) => f[k]), now(), row.id],
        },
        audit(c.get('user').id, 'component.updated', 'project', a.project.id, { name: f.name || row.name, fields: cols }),
      ]);
    }
    return c.json({ component: componentOut(await componentRow(db, row.id)) });
  });

  // Delete a component. ?moveTo=<component id> puts its issues in that component first.
  app.delete('/api/projects/:key/components/:id', async (c) => {
    const { a, row, db } = await loadComponent(c);
    const moveTo = c.req.query('moveTo');
    const stmts = [];
    if (moveTo) {
      const target = await db.get('SELECT id, name FROM components WHERE id = ? AND project_id = ?', [moveTo, a.project.id]);
      if (!target || target.id === row.id) fail(400, 'Pick another component of this project to move the issues to');
      stmts.push({
        sql: `INSERT INTO issue_components (issue_id, component_id) SELECT issue_id, ? FROM issue_components WHERE component_id = ? ON CONFLICT DO NOTHING`,
        params: [target.id, row.id],
      });
    }
    const n = await db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM issue_components WHERE component_id = ?', [row.id]);
    stmts.push(
      { sql: 'DELETE FROM issue_components WHERE component_id = ?', params: [row.id] },
      { sql: 'DELETE FROM components WHERE id = ?', params: [row.id] },
      audit(c.get('user').id, 'component.deleted', 'project', a.project.id, {
        name: row.name,
        issues: n.n,
        ...(moveTo ? { movedTo: moveTo } : {}),
      }),
    );
    await db.batch(stmts);
    return c.json({ ok: true, issues: n.n });
  });

  // ---------- releases ----------

  function readRelease(b, current) {
    const out = {};
    if (!current || b.name !== undefined) out.name = str(b.name, { required: true, max: 80, name: 'Name' });
    if (b.description !== undefined) out.description = str(b.description, { max: 5000, name: 'Description' }) || null;
    const start = isoDate(b.startDate, 'Start date');
    if (start !== undefined) out.start_date = start;
    const rel = isoDate(b.releaseDate, 'Release date');
    if (rel !== undefined) out.release_date = rel;
    const s = out.start_date === undefined ? current?.start_date : out.start_date;
    const r = out.release_date === undefined ? current?.release_date : out.release_date;
    if (s && r && s > r) fail(400, 'Start date must be on or before the release date');
    if (b.status !== undefined) {
      if (b.status === 'released') fail(400, 'Use the Release action to release a version');
      if (!['unreleased', 'archived'].includes(b.status)) fail(400, 'status must be unreleased or archived');
      out.status = b.status;
      if (b.status === 'unreleased') out.released_at = null;
    }
    return out;
  }
  const nameTaken = (db, projectId, name, exceptId = '') =>
    db.get('SELECT id FROM releases WHERE project_id = ? AND LOWER(name) = ? AND id <> ?', [projectId, name.toLowerCase(), exceptId]);

  app.get('/api/projects/:key/releases', async (c) => {
    const a = await projectAccess(c, c.req.param('key'));
    const db = c.env.db;
    const [rows, progress] = await Promise.all([listReleases(db, a.project.id), releaseProgress(db, a.project.id)]);
    const day = await today(c);
    return c.json({ releases: rows.map((r) => releaseOut(r, progress.get(r.id), day)), canAdmin: a.canAdmin });
  });

  app.post('/api/projects/:key/releases', async (c) => {
    const a = await projectAccess(c, c.req.param('key'), 'admin');
    const db = c.env.db;
    const f = readRelease(await body(c), null);
    if (f.status === 'archived') f.status = 'unreleased';
    if (await nameTaken(db, a.project.id, f.name)) fail(409, `A release named "${f.name}" already exists`);
    const count = await db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM releases WHERE project_id = ?', [a.project.id]);
    if (count.n >= MAX_RELEASES) fail(400, `A project can have at most ${MAX_RELEASES} releases. Delete old ones first.`);
    const id = uuid();
    const t = now();
    await db.batch([
      {
        sql: 'INSERT INTO releases (id, project_id, name, description, start_date, release_date, status, released_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        params: [id, a.project.id, f.name, f.description ?? null, f.start_date ?? null, f.release_date ?? null, 'unreleased', null, t, t],
      },
      audit(c.get('user').id, 'release.created', 'project', a.project.id, { name: f.name }),
    ]);
    return c.json({ release: releaseOut(await db.get('SELECT * FROM releases WHERE id = ?', [id]), undefined, await today(c)) }, 201);
  });

  async function loadRelease(c, need = 'view') {
    const a = await projectAccess(c, c.req.param('key'), need);
    const row = await c.env.db.get('SELECT * FROM releases WHERE id = ? AND project_id = ?', [c.req.param('id'), a.project.id]);
    if (!row) fail(404, 'Release not found');
    return { a, row, db: c.env.db };
  }

  /** Every issue of a release the caller can see (Trash left out), with components and fix versions. */
  async function releaseIssues(db, user, project, release) {
    const r = await searchIssues(
      db,
      user,
      { project: project.key, fixVersion: release.id, archived: '1', sort: 'rank', limit: RELEASE_PAGE_MAX },
      { blocked: false },
    );
    await withReleases(db, r.issues);
    return r;
  }

  // The release page: the release with progress and its issues.
  app.get('/api/projects/:key/releases/:id', async (c) => {
    const { a, row, db } = await loadRelease(c);
    const [progress, list] = await Promise.all([
      releaseProgress(db, a.project.id, row.id),
      releaseIssues(db, c.get('user'), a.project, row),
    ]);
    const others = (await listReleases(db, a.project.id))
      .filter((r) => r.id !== row.id && r.status === 'unreleased')
      .map((r) => ({ id: r.id, name: r.name }));
    return c.json({
      release: releaseOut(row, progress.get(row.id), await today(c)),
      issues: list.issues,
      total: list.total,
      canAdmin: a.canAdmin,
      moveTargets: others,
    });
  });

  app.patch('/api/projects/:key/releases/:id', async (c) => {
    const { a, row, db } = await loadRelease(c, 'admin');
    const f = readRelease(await body(c), row);
    if (f.name && (await nameTaken(db, a.project.id, f.name, row.id))) fail(409, `A release named "${f.name}" already exists`);
    const cols = Object.keys(f);
    if (cols.length) {
      await db.batch([
        {
          sql: `UPDATE releases SET ${[...cols.map((k) => `${k} = ?`), 'updated_at = ?'].join(', ')} WHERE id = ?`,
          params: [...cols.map((k) => f[k]), now(), row.id],
        },
        audit(
          c.get('user').id,
          f.status && f.status !== row.status ? `release.${f.status === 'archived' ? 'archived' : 'unreleased'}` : 'release.updated',
          'project',
          a.project.id,
          { name: f.name || row.name, fields: cols },
        ),
      ]);
    }
    const progress = await releaseProgress(db, a.project.id, row.id);
    return c.json({
      release: releaseOut(await db.get('SELECT * FROM releases WHERE id = ?', [row.id]), progress.get(row.id), await today(c)),
    });
  });

  // Delete a release. ?moveTo=<release id> gives its issues that fix version first.
  app.delete('/api/projects/:key/releases/:id', async (c) => {
    const { a, row, db } = await loadRelease(c, 'admin');
    const moveTo = c.req.query('moveTo');
    const stmts = [];
    if (moveTo) {
      const target = await db.get(`SELECT id FROM releases WHERE id = ? AND project_id = ? AND status <> 'archived'`, [
        moveTo,
        a.project.id,
      ]);
      if (!target || target.id === row.id) fail(400, 'Pick another release of this project to move the issues to');
      stmts.push({
        sql: 'INSERT INTO issue_releases (issue_id, release_id) SELECT issue_id, ? FROM issue_releases WHERE release_id = ? ON CONFLICT DO NOTHING',
        params: [target.id, row.id],
      });
    }
    const n = await db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM issue_releases WHERE release_id = ?', [row.id]);
    stmts.push(
      { sql: 'DELETE FROM issue_releases WHERE release_id = ?', params: [row.id] },
      { sql: 'DELETE FROM releases WHERE id = ?', params: [row.id] },
      audit(c.get('user').id, 'release.deleted', 'project', a.project.id, {
        name: row.name,
        issues: n.n,
        ...(moveTo ? { movedTo: moveTo } : {}),
      }),
    );
    await db.batch(stmts);
    return c.json({ ok: true, issues: n.n });
  });

  /**
   * Release: { releaseDate?, moveOpenTo? }. With open issues (status not done; the Trash does not count) the call
   * answers 409 { open } unless moveOpenTo is given: a release id moves them to that unreleased version, null takes
   * the fix version off them ("Release anyway"). Each moved issue gets a history row.
   */
  app.post('/api/projects/:key/releases/:id/release', async (c) => {
    const { a, row, db } = await loadRelease(c, 'admin');
    if (row.status === 'released') fail(400, 'This version is already released');
    if (row.status === 'archived') fail(400, 'This version is archived. Restore it first.');
    const b = await body(c);
    const releaseDate = isoDate(b.releaseDate, 'Release date') || row.release_date || (await today(c));
    const open = await db.all(
      `SELECT i.id FROM issue_releases ir JOIN issues i ON i.id = ir.issue_id JOIN statuses s ON s.id = i.status_id
        WHERE ir.release_id = ? AND i.deleted_at IS NULL AND s.category <> 'done'`,
      [row.id],
    );
    const user = c.get('user');
    const t = now();
    const stmts = [];
    let target = null;
    if (open.length) {
      if (b.moveOpenTo === undefined)
        fail(
          409,
          `${open.length} issue${open.length === 1 ? ' is' : 's are'} not done. Move ${open.length === 1 ? 'it' : 'them'} to another version or release anyway.`,
          { open: open.length },
        );
      if (b.moveOpenTo !== null && b.moveOpenTo !== '') {
        target = await db.get(`SELECT id, name FROM releases WHERE id = ? AND project_id = ? AND status = 'unreleased'`, [
          String(b.moveOpenTo),
          a.project.id,
        ]);
        if (!target || target.id === row.id) fail(400, 'Pick another unreleased version of this project');
      }
      // history: the issue's fix versions before and after
      const ids = open.map((x) => x.id);
      const names = new Map();
      for (const part of chunks(ids)) {
        const rows = await db.all(
          `SELECT ir.issue_id, r.id, r.name FROM issue_releases ir JOIN releases r ON r.id = ir.release_id WHERE ir.issue_id IN (${placeholders(part.length)})`,
          part,
        );
        for (const r of rows) names.set(r.issue_id, [...(names.get(r.issue_id) || []), r]);
      }
      const text = (list) =>
        list.length
          ? list
              .map((r) => r.name)
              .sort((x, y) => x.localeCompare(y))
              .join(', ')
          : null;
      const history = [];
      for (const id of ids) {
        const before = names.get(id) || [];
        const after = before.filter((r) => r.id !== row.id && (!target || r.id !== target.id));
        if (target) after.push(target);
        stmts.push({ sql: 'DELETE FROM issue_releases WHERE issue_id = ? AND release_id = ?', params: [id, row.id] });
        if (target)
          stmts.push({
            sql: 'INSERT INTO issue_releases (issue_id, release_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
            params: [id, target.id],
          });
        stmts.push({ sql: 'UPDATE issues SET updated_at = ? WHERE id = ?', params: [t, id] });
        history.push([id, 'fix_versions', text(before), text(after)]);
      }
      stmts.push(...historyStmts(user.id, t, history, changeSource(c)));
    }
    stmts.push(
      {
        sql: `UPDATE releases SET status = 'released', released_at = ?, release_date = ?, updated_at = ? WHERE id = ?`,
        params: [t, releaseDate, t, row.id],
      },
      audit(user.id, 'release.released', 'project', a.project.id, {
        name: row.name,
        moved: open.length,
        ...(target ? { movedTo: target.name } : open.length ? { movedTo: null } : {}),
      }),
    );
    await db.batch(stmts);
    webhookNotify(c, {
      event: 'release.released',
      projectId: a.project.id,
      release: {
        id: row.id,
        name: row.name,
        description: row.description ? String(row.description).slice(0, 1000) : null,
        releaseDate,
        releasedAt: t,
        movedOpenIssues: open.length,
        movedTo: target ? target.name : null,
      },
    }); // outgoing webhooks
    const progress = await releaseProgress(db, a.project.id, row.id);
    return c.json({
      release: releaseOut(await db.get('SELECT * FROM releases WHERE id = ?', [row.id]), progress.get(row.id), await today(c)),
      moved: open.length,
      movedTo: target ? { id: target.id, name: target.name } : null,
    });
  });

  // Release notes as Markdown, done issues grouped by type. ?download=1 sends a .md file.
  app.get('/api/projects/:key/releases/:id/notes', async (c) => {
    const { a, row, db } = await loadRelease(c);
    const list = await releaseIssues(db, c.get('user'), a.project, row);
    const release = releaseOut(row, undefined, await today(c));
    const markdown = releaseNotes(a.project, release, list.issues, publicOrigin(c));
    const filename = notesFilename(a.project, release);
    if (c.req.query('download') === '1') {
      return c.body(markdown, 200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
      });
    }
    return c.json({ markdown, filename });
  });
}
