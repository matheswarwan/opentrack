// Custom reports and dashboards (the Reports page, like Jira's filter gadgets).
//
// POST /api/report-data works out one report as the caller: every query goes through issueFilter
// (routes/issues.js), so project visibility and API token project scope are the same as in issue
// search. Saved reports and dashboards only store definitions; a shared report is always worked out
// as the person looking at it.
//
// Portable SQL (SQLite/D1 and Postgres): GROUP BY on plain columns, date bucketing in JS, and one to
// three queries per report (D1 allows about 50 queries per request on the free plan).
// The report engine (definitions, validation, queries) is server/lib/customReports.js.
import { body, fail, str } from '../lib/http.js';
import { uuid, now } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { isGuest, ownedVisibleSql, canEditOwned } from '../lib/access.js';
import { placeholders } from '../db/sql.js';
import { parseJson } from '../lib/json.js';
import { KINDS, pick, cleanSource, cleanOptions, runReport } from '../lib/customReports.js';

const MAX_LAYOUT = 24; // reports on one dashboard

const canEdit = (user, ownerId) => canEditOwned(user, ownerId, { admin: true });
// Guests (external clients) see and use only their own reports, dashboards and filters (ownedVisibleSql), and cannot share them.
function noGuestSharing(user, visibility) {
  if (visibility === 'shared' && isGuest(user)) fail(403, 'Guests cannot share reports or dashboards');
  return visibility;
}

function reportOut(r, user) {
  return {
    id: r.id,
    name: r.name,
    description: r.description || '',
    source: parseJson(r.source, { query: {} }),
    kind: r.kind,
    options: parseJson(r.options, {}),
    visibility: r.visibility,
    owner: { id: r.owner_id, name: r.owner_name },
    mine: r.owner_id === user.id,
    canEdit: canEdit(user, r.owner_id),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
function dashboardOut(d, user) {
  return {
    id: d.id,
    name: d.name,
    layout: parseJson(d.layout, []),
    visibility: d.visibility,
    owner: { id: d.owner_id, name: d.owner_name },
    mine: d.owner_id === user.id,
    canEdit: canEdit(user, d.owner_id),
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

const REPORT_SELECT = 'SELECT r.*, u.name AS owner_name FROM reports r JOIN users u ON u.id = r.owner_id';
const DASH_SELECT = 'SELECT d.*, u.name AS owner_name FROM dashboards d JOIN users u ON u.id = d.owner_id';

async function visibleReport(db, user, id) {
  const v = ownedVisibleSql(user, { alias: 'r' });
  const r = await db.get(`${REPORT_SELECT} WHERE r.id = ? AND ${v.sql}`, [id, ...v.params]);
  if (!r) fail(404, 'Report not found');
  return r;
}
async function visibleDashboard(db, user, id) {
  const v = ownedVisibleSql(user, { alias: 'd' });
  const d = await db.get(`${DASH_SELECT} WHERE d.id = ? AND ${v.sql}`, [id, ...v.params]);
  if (!d) fail(404, 'Dashboard not found');
  return d;
}

/** Check a report definition; a shared report cannot sit on a private filter (others could not run it). */
async function cleanReport(db, user, b, current) {
  const name = str(b.name ?? current?.name, { required: true, max: 100, name: 'Name' });
  const description = str(b.description === undefined ? (current?.description ?? '') : (b.description ?? ''), {
    max: 1000,
    name: 'Description',
  });
  const kind = b.kind ?? current?.kind;
  const options = cleanOptions(kind, b.options ?? (current ? parseJson(current.options, {}) : {}));
  const source = cleanSource(b.source ?? (current ? parseJson(current.source, {}) : undefined));
  const visibility = noGuestSharing(user, pick(b.visibility ?? current?.visibility, ['private', 'shared'], 'private', 'visibility'));
  if (source.filterId) {
    const v = ownedVisibleSql(user, { shared: 'flag' });
    const f = await db.get(`SELECT shared, owner_id FROM saved_filters WHERE id = ? AND ${v.sql}`, [source.filterId, ...v.params]);
    if (!f) fail(400, 'Saved filter not found');
    if (visibility === 'shared' && !f.shared)
      fail(400, 'This saved filter is private. Share the filter first, or build the report from its conditions.');
  }
  return { name, description, kind, options, source, visibility };
}

async function cleanLayout(db, user, layout) {
  if (!Array.isArray(layout)) fail(400, 'layout must be a list');
  if (layout.length > MAX_LAYOUT) fail(400, `A dashboard holds at most ${MAX_LAYOUT} reports`);
  const out = layout.map((x) => {
    if (!x || typeof x !== 'object') fail(400, 'Each layout item needs a reportId');
    return {
      reportId: str(String(x.reportId ?? ''), { required: true, max: 64, name: 'reportId' }),
      width: pick(x.width, ['half', 'full'], 'half', 'width'),
    };
  });
  const ids = [...new Set(out.map((x) => x.reportId))];
  if (ids.length) {
    const v = ownedVisibleSql(user);
    const found = await db.all(`SELECT id FROM reports WHERE id IN (${placeholders(ids.length)}) AND ${v.sql}`, [...ids, ...v.params]);
    const ok = new Set(found.map((r) => r.id));
    if (ids.some((id) => !ok.has(id))) fail(400, 'A report on this dashboard was not found');
  }
  return out;
}

/** The four reports of "Create my dashboard". */
const STARTER = [
  {
    name: 'My open work by status',
    kind: 'breakdown',
    source: { query: { assignee: 'me', category: 'todo,in_progress' } },
    options: { groupBy: 'status', metric: 'count', chart: 'pie' },
    width: 'half',
  },
  { name: 'Workload by assignee', kind: 'workload', source: { query: { category: 'todo,in_progress' } }, options: {}, width: 'half' },
  {
    name: 'Created vs resolved, last 30 days',
    kind: 'createdVsResolved',
    source: { query: {} },
    options: { period: 'day', days: 30, chart: 'line' },
    width: 'full',
  },
  {
    name: 'Due in the next 14 days',
    kind: 'list',
    source: { query: { category: 'todo,in_progress', dueWithinDays: '14' } },
    options: { sort: 'due', dir: 'asc', limit: 15, columns: ['key', 'title', 'assignee', 'due', 'status'] },
    width: 'full',
  },
];

export function registerCustomReports(app) {
  app.post('/api/report-data', async (c) => {
    const db = c.env.db;
    const user = c.get('user');
    const b = await body(c);
    let def;
    if (b.reportId) {
      const r = await visibleReport(db, user, String(b.reportId));
      def = { source: cleanSource(parseJson(r.source, {})), kind: r.kind, options: cleanOptions(r.kind, parseJson(r.options, {})) };
    } else {
      def = { source: cleanSource(b.source), kind: pick(b.kind, KINDS, undefined, 'kind') };
      def.options = cleanOptions(def.kind, b.options || {});
    }
    return c.json(await runReport(db, user, def));
  });

  // ---- saved reports ----
  app.get('/api/saved-reports', async (c) => {
    const user = c.get('user');
    const v = ownedVisibleSql(user, { alias: 'r' });
    const rows = await c.env.db.all(`${REPORT_SELECT} WHERE ${v.sql} ORDER BY LOWER(r.name)`, v.params);
    return c.json({ reports: rows.map((r) => reportOut(r, user)) });
  });

  app.get('/api/saved-reports/:id', async (c) => {
    const user = c.get('user');
    return c.json({ report: reportOut(await visibleReport(c.env.db, user, c.req.param('id')), user) });
  });

  app.post('/api/saved-reports', async (c) => {
    const db = c.env.db;
    const user = c.get('user');
    const r = await cleanReport(db, user, await body(c));
    const id = uuid();
    const t = now();
    await db.batch([
      {
        sql: 'INSERT INTO reports (id, owner_id, name, description, source, kind, options, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        params: [
          id,
          user.id,
          r.name,
          r.description || null,
          JSON.stringify(r.source),
          r.kind,
          JSON.stringify(r.options),
          r.visibility,
          t,
          t,
        ],
      },
      audit(user.id, 'report.created', 'report', id, { name: r.name, kind: r.kind, visibility: r.visibility }),
    ]);
    return c.json({ report: reportOut(await visibleReport(db, user, id), user) }, 201);
  });

  app.patch('/api/saved-reports/:id', async (c) => {
    const db = c.env.db;
    const user = c.get('user');
    const cur = await visibleReport(db, user, c.req.param('id'));
    if (!canEdit(user, cur.owner_id)) fail(403, 'Only the owner can change this report');
    const r = await cleanReport(db, user, await body(c), cur);
    await db.run(
      'UPDATE reports SET name = ?, description = ?, source = ?, kind = ?, options = ?, visibility = ?, updated_at = ? WHERE id = ?',
      [r.name, r.description || null, JSON.stringify(r.source), r.kind, JSON.stringify(r.options), r.visibility, now(), cur.id],
    );
    return c.json({ report: reportOut(await visibleReport(db, user, cur.id), user) });
  });

  app.delete('/api/saved-reports/:id', async (c) => {
    const db = c.env.db;
    const user = c.get('user');
    const cur = await visibleReport(db, user, c.req.param('id'));
    if (!canEdit(user, cur.owner_id)) fail(403, 'Only the owner can delete this report');
    await db.batch([
      { sql: 'DELETE FROM reports WHERE id = ?', params: [cur.id] },
      audit(user.id, 'report.deleted', 'report', cur.id, { name: cur.name }),
    ]);
    return c.json({ ok: true });
  });

  // ---- dashboards ----
  app.get('/api/dashboards', async (c) => {
    const user = c.get('user');
    const v = ownedVisibleSql(user, { alias: 'd' });
    const rows = await c.env.db.all(`${DASH_SELECT} WHERE ${v.sql} ORDER BY LOWER(d.name)`, v.params);
    return c.json({ dashboards: rows.map((d) => dashboardOut(d, user)) });
  });

  // a dashboard with its reports; a report the viewer cannot see (private, deleted) comes back as null
  app.get('/api/dashboards/:id', async (c) => {
    const db = c.env.db;
    const user = c.get('user');
    const d = dashboardOut(await visibleDashboard(db, user, c.req.param('id')), user);
    const ids = [...new Set(d.layout.map((x) => x.reportId))].slice(0, MAX_LAYOUT);
    const v = ownedVisibleSql(user, { alias: 'r' });
    const rows = ids.length
      ? await db.all(`${REPORT_SELECT} WHERE r.id IN (${placeholders(ids.length)}) AND ${v.sql}`, [...ids, ...v.params])
      : [];
    const byId = new Map(rows.map((r) => [r.id, reportOut(r, user)]));
    d.layout = d.layout.map((x) => ({ ...x, report: byId.get(x.reportId) || null }));
    return c.json({ dashboard: d });
  });

  app.post('/api/dashboards', async (c) => {
    const db = c.env.db;
    const user = c.get('user');
    const b = await body(c);
    const name = str(b.name, { required: true, max: 100, name: 'Name' });
    const visibility = noGuestSharing(user, pick(b.visibility, ['private', 'shared'], 'private', 'visibility'));
    const layout = await cleanLayout(db, user, b.layout || []);
    const id = uuid();
    const t = now();
    await db.batch([
      {
        sql: 'INSERT INTO dashboards (id, owner_id, name, layout, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        params: [id, user.id, name, JSON.stringify(layout), visibility, t, t],
      },
      audit(user.id, 'dashboard.created', 'dashboard', id, { name }),
    ]);
    return c.json({ dashboard: dashboardOut(await visibleDashboard(db, user, id), user) }, 201);
  });

  // "Create my dashboard": four starter reports and a dashboard holding them, in one transaction
  app.post('/api/dashboards/starter', async (c) => {
    const db = c.env.db;
    const user = c.get('user');
    const t = now();
    const id = uuid();
    const stmts = [];
    const layout = [];
    for (const s of STARTER) {
      const rid = uuid();
      const options = cleanOptions(s.kind, s.options);
      stmts.push({
        sql: 'INSERT INTO reports (id, owner_id, name, description, source, kind, options, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        params: [rid, user.id, s.name, null, JSON.stringify(s.source), s.kind, JSON.stringify(options), 'private', t, t],
      });
      layout.push({ reportId: rid, width: s.width });
    }
    stmts.push({
      sql: 'INSERT INTO dashboards (id, owner_id, name, layout, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      params: [id, user.id, 'My dashboard', JSON.stringify(layout), 'private', t, t],
    });
    stmts.push(audit(user.id, 'dashboard.created', 'dashboard', id, { name: 'My dashboard', starter: true }));
    await db.batch(stmts);
    return c.json({ dashboard: dashboardOut(await visibleDashboard(db, user, id), user) }, 201);
  });

  app.patch('/api/dashboards/:id', async (c) => {
    const db = c.env.db;
    const user = c.get('user');
    const cur = await visibleDashboard(db, user, c.req.param('id'));
    if (!canEdit(user, cur.owner_id)) fail(403, 'Only the owner can change this dashboard');
    const b = await body(c);
    const name = b.name === undefined ? cur.name : str(b.name, { required: true, max: 100, name: 'Name' });
    const visibility =
      b.visibility === undefined
        ? cur.visibility
        : noGuestSharing(user, pick(b.visibility, ['private', 'shared'], undefined, 'visibility'));
    const layout = b.layout === undefined ? cur.layout : JSON.stringify(await cleanLayout(db, user, b.layout));
    await db.run('UPDATE dashboards SET name = ?, layout = ?, visibility = ?, updated_at = ? WHERE id = ?', [
      name,
      layout,
      visibility,
      now(),
      cur.id,
    ]);
    return c.json({ dashboard: dashboardOut(await visibleDashboard(db, user, cur.id), user) });
  });

  app.delete('/api/dashboards/:id', async (c) => {
    const db = c.env.db;
    const user = c.get('user');
    const cur = await visibleDashboard(db, user, c.req.param('id'));
    if (!canEdit(user, cur.owner_id)) fail(403, 'Only the owner can delete this dashboard');
    await db.batch([
      { sql: 'DELETE FROM dashboards WHERE id = ?', params: [cur.id] },
      audit(user.id, 'dashboard.deleted', 'dashboard', cur.id, { name: cur.name }),
    ]);
    return c.json({ ok: true });
  });
}
