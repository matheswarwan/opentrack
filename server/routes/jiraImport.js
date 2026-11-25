// Admin > Import from Jira. The browser connects, chooses projects and options, then calls
// POST /api/admin/jira-import/:id/step again and again; each call runs one slice (server/lib/jiraImport.js).
// The Jira API token is kept in the import row only until the run ends, and is never sent back.
import { body, fail, str } from '../lib/http.js';
import { uuid, now } from '../lib/crypto.js';
import { requireAdmin } from '../lib/session.js';
import { audit } from '../lib/audit.js';
import { clock } from '../lib/time.js';
import { importOut, runStep, expireStaleCredentials } from '../lib/jiraImport.js';
import { cleanSite, suggestKey, KEY_RE } from '../lib/jira/map.js';
import { jiraClient, listJiraProjects, JiraError } from '../lib/jira/client.js';
import { placeholders, chunks } from '../db/sql.js';

const ACTIVE = ['running', 'waiting'];

function admin(c) {
  requireAdmin(c);
  c.set('skipJobs', true); // keep this request's query budget for the import
}

async function load(c, id) {
  const r = await c.env.db.get('SELECT * FROM jira_imports WHERE id = ?', [id]);
  if (!r) fail(404, 'Import not found');
  return r;
}

async function recentErrors(db, id) {
  const rows = await db.all(
    'SELECT stage, jira_key, message, created_at FROM jira_import_errors WHERE import_id = ? ORDER BY created_at DESC, id LIMIT 200',
    [id],
  );
  const total = await db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM jira_import_errors WHERE import_id = ?', [id]);
  return { total: total.n, items: rows.map((e) => ({ stage: e.stage, key: e.jira_key, message: e.message, at: e.created_at })) };
}

async function takenKeys(db, keys) {
  const out = new Set();
  for (const part of chunks(keys, 90)) {
    for (const r of await db.all(`SELECT key FROM projects WHERE key IN (${placeholders(part.length)})`, part)) out.add(r.key);
  }
  return out;
}

function jiraFail(e) {
  if (e instanceof JiraError) {
    if (e.status === 429) fail(429, `Jira asked to slow down. Try again in ${e.retryAfter} seconds.`);
    fail(e.status === 401 || e.status === 403 ? 400 : 502, `Jira: ${e.message}`);
  }
  throw e;
}

async function projectsWithKeys(db, list) {
  const candidates = new Set();
  for (const p of list) {
    const base = String(p.key)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
    candidates.add(p.key.toUpperCase());
    for (let i = 0; i < 4; i++) candidates.add(i ? `${base.slice(0, 9)}${i + 1}` : base);
  }
  const taken = await takenKeys(db, [...candidates]);
  return list.map((p) => {
    const free = KEY_RE.test(p.key) && !taken.has(p.key);
    return { ...p, keyFree: free, targetKey: free ? p.key : suggestKey(p.key, taken) };
  });
}

export function registerJiraImport(app) {
  app.get('/api/admin/jira-import', async (c) => {
    admin(c);
    const db = c.env.db;
    await expireStaleCredentials(db, clock(c.env));
    const rows = await db.all('SELECT * FROM jira_imports ORDER BY created_at DESC LIMIT 20');
    return c.json({ imports: rows.map((r) => importOut(r)) });
  });

  // Step 1: check the credentials and list the projects. Creates the import row (credentials kept until the run ends).
  app.post('/api/admin/jira-import/connect', async (c) => {
    admin(c);
    const b = await body(c);
    const site = cleanSite(b.site);
    if (!site) fail(400, 'Enter your Jira site, like https://yourcompany.atlassian.net');
    const email = str(b.email, { required: true, max: 200, name: 'Email' });
    const token = str(b.token, { required: true, max: 500, name: 'API token' });
    const jira = jiraClient({ fetch: c.env.fetch || ((...a) => fetch(...a)), site, email, token });
    let me, projects;
    try {
      me = await jira.get('/rest/api/3/myself');
      projects = await listJiraProjects(jira);
    } catch (e) {
      jiraFail(e);
    }
    const db = c.env.db;
    const id = uuid();
    const t = now();
    const list = await projectsWithKeys(db, projects);
    await db.run(
      `INSERT INTO jira_imports (id, site, jira_email, jira_token, jira_user, status, state, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'connected', ?, ?, ?, ?)`,
      [
        id,
        site,
        email,
        token,
        me.displayName || me.emailAddress || email,
        JSON.stringify({ jiraProjects: projects }),
        c.get('user').id,
        t,
        t,
      ],
    );
    return c.json({ import: importOut(await load(c, id)), projects: list }, 201);
  });

  app.get('/api/admin/jira-import/:id', async (c) => {
    admin(c);
    const r = await load(c, c.req.param('id'));
    const imp = importOut(r, await recentErrors(c.env.db, r.id));
    if (['connected', 'planned', 'ready'].includes(r.status)) imp.jiraProjects = await projectsWithKeys(c.env.db, imp.jiraProjects);
    return c.json({ import: imp });
  });

  // Step 2: projects with their target keys, and options. Clears an earlier dry run.
  app.put('/api/admin/jira-import/:id/plan', async (c) => {
    admin(c);
    const r = await load(c, c.req.param('id'));
    if (!['connected', 'planned', 'ready'].includes(r.status)) fail(400, 'This import has already started');
    const b = await body(c);
    const jiraProjects = JSON.parse(r.state || '{}').jiraProjects || [];
    if (!Array.isArray(b.projects) || !b.projects.length) fail(400, 'Choose at least one Jira project');
    if (b.projects.length > 50) fail(400, 'At most 50 projects in one import');
    const seen = new Set();
    const projects = b.projects.map((x) => {
      const jp = jiraProjects.find((p) => p.key === x.jiraKey);
      if (!jp) fail(400, `Jira project not found: ${x.jiraKey}`);
      const targetKey = String(x.targetKey || '')
        .trim()
        .toUpperCase();
      if (!KEY_RE.test(targetKey)) fail(400, `Key for ${jp.key} must be 2 to 10 letters or digits and start with a letter`);
      if (seen.has(targetKey)) fail(400, `Key ${targetKey} is used twice`);
      seen.add(targetKey);
      return { jiraId: jp.id, jiraKey: jp.key, name: jp.name, targetKey };
    });
    const taken = await takenKeys(c.env.db, [...seen]);
    if (taken.size) fail(409, `Key already used by a project: ${[...taken].join(', ')}`);
    const o = b.options || {};
    const options = {
      comments: o.comments !== false,
      closedSprints: Boolean(o.closedSprints),
      attachments: Boolean(o.attachments),
      worklogs: Boolean(o.worklogs),
      createUsers: Boolean(o.createUsers),
    };
    await c.env.db.run(
      `UPDATE jira_imports SET status = 'planned', plan = ?, options = ?, dry_run = NULL, people = NULL, stage = NULL, updated_at = ? WHERE id = ?`,
      [JSON.stringify({ projects }), JSON.stringify(options), now(), r.id],
    );
    return c.json({ import: importOut(await load(c, r.id)) });
  });

  // Dry run: counts only, nothing written. Driven by /step like the import.
  app.post('/api/admin/jira-import/:id/dry-run', async (c) => {
    admin(c);
    const r = await load(c, c.req.param('id'));
    if (!['planned', 'ready'].includes(r.status)) fail(400, 'Choose the projects first');
    if (!r.jira_token) fail(400, 'The Jira credentials are gone. Start a new import.');
    const state = JSON.parse(r.state || '{}');
    await c.env.db.run(
      `UPDATE jira_imports SET status = 'running', mode = 'dryrun', stage = 'fields', dry_run = NULL, people = NULL, state = ?, updated_at = ? WHERE id = ?`,
      [JSON.stringify({ jiraProjects: state.jiraProjects }), now(), r.id],
    );
    return c.json({ import: importOut(await load(c, r.id)) });
  });

  app.post('/api/admin/jira-import/:id/start', async (c) => {
    admin(c);
    const r = await load(c, c.req.param('id'));
    if (!['planned', 'ready'].includes(r.status)) fail(400, 'Choose the projects first');
    if (!r.jira_token) fail(400, 'The Jira credentials are gone. Start a new import.');
    const plan = JSON.parse(r.plan);
    const taken = await takenKeys(
      c.env.db,
      plan.projects.map((p) => p.targetKey),
    );
    if (taken.size) fail(409, `Key already used by a project: ${[...taken].join(', ')}`);
    const dryDone = r.status === 'ready' && JSON.parse(r.dry_run || 'null')?.done;
    const state = JSON.parse(r.state || '{}');
    const t = now();
    await c.env.db.batch([
      {
        sql: `UPDATE jira_imports SET status = 'running', mode = 'import', stage = ?, state = ?, progress = NULL, updated_at = ? WHERE id = ?`,
        params: [
          dryDone ? 'users' : 'fields',
          JSON.stringify(dryDone ? { ...state, pi: 0, token: null } : { jiraProjects: state.jiraProjects }),
          t,
          r.id,
        ],
      },
      audit(c.get('user').id, 'jira_import.started', 'jira_import', r.id, {
        site: r.site,
        projects: plan.projects.map((p) => `${p.jiraKey}->${p.targetKey}`),
      }),
    ]);
    return c.json({ import: importOut(await load(c, r.id)) });
  });

  app.post('/api/admin/jira-import/:id/step', async (c) => {
    admin(c);
    const id = c.req.param('id');
    await load(c, id);
    const r = await runStep(c, id, c.get('user'));
    const row = await load(c, id);
    return c.json({ busy: Boolean(r.busy), import: importOut(row, await recentErrors(c.env.db, id)) });
  });

  app.post('/api/admin/jira-import/:id/cancel', async (c) => {
    admin(c);
    const r = await load(c, c.req.param('id'));
    if (['done', 'cancelled', 'error'].includes(r.status)) fail(400, 'This import has already ended');
    const t = now();
    await c.env.db.batch([
      {
        sql: `UPDATE jira_imports SET status = 'cancelled', jira_email = NULL, jira_token = NULL, lease_until = NULL, finished_at = ?, updated_at = ? WHERE id = ?`,
        params: [t, t, r.id],
      },
      audit(c.get('user').id, 'jira_import.cancelled', 'jira_import', r.id, {
        site: r.site,
        stage: r.stage,
        wasRunning: ACTIVE.includes(r.status),
      }),
    ]);
    return c.json({ import: importOut(await load(c, r.id)) });
  });
}
