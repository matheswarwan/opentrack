// Project budgets, rates, burn and billable work (server/lib/budgets.js).
//   GET    /api/projects/:key/budget              budget and burn (admins: money; members: hours only; guests: 404)
//   PUT    /api/projects/:key/budget              set the budget { kind, amount, currency, startDate, endDate, thresholds, lines } (project admins)
//   DELETE /api/projects/:key/budget              remove the budget (project admins; rates are kept)
//   POST   /api/projects/:key/budget/rates        add a rate { scope, role?, userId?, rate, effectiveFrom } (project admins)
//   DELETE /api/projects/:key/budget/rates/:id    remove a rate (project admins)
//   GET    /api/projects/:key/budget/export.csv   billable hours and cost by person and week ?from&to (project admins)
//   PATCH  /api/worklogs/:id                      { billable } (the author, or a project admin)
//   POST   /api/worklogs/billable                 { ids, billable } several at once (own entries; project admins: any in their project)
import { body, fail, str, num, isoDate } from '../lib/http.js';
import { uuid, now } from '../lib/crypto.js';
import { projectAccess, MEMBER_ROLES, GUEST_LEVELS } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import { clock, addDays, today } from '../lib/time.js';
import { assertWeeksOpen } from '../lib/timeTracking.js';
import { csvCell } from '../lib/csv.js';
import {
  BUDGET_KINDS,
  RATE_SCOPES,
  DEFAULT_THRESHOLDS,
  DEFAULT_CURRENCY,
  budgetOut,
  rateOut,
  loadRates,
  computeBurn,
  forViewer,
  checkBudgetAlerts,
  billableRows,
} from '../lib/budgets.js';
import { placeholders } from '../db/sql.js';

const MAX_LINES = 50;
const MAX_IDS = 90; // bound values per query stay under D1's 100
const MAX_EXPORT_DAYS = 366;

/** Project access that hides the budget from guests (404, as if it did not exist). */
async function budgetAccess(c, need = 'view') {
  const a = await projectAccess(c, c.req.param('key'));
  if (a.guest) fail(404, 'Not found');
  if (need === 'admin' && !a.canAdmin) fail(403, 'Only project admins can do this');
  return a;
}

function readThresholds(v) {
  if (v === undefined || v === null) return [...DEFAULT_THRESHOLDS];
  if (!Array.isArray(v) || !v.length || v.length > 5) fail(400, 'Alert thresholds must be a list of 1 to 5 percentages');
  const out = [...new Set(v.map((x) => num(x, { name: 'Alert threshold', min: 1, max: 500 })))]
    .filter((x) => x !== null)
    .map((x) => Math.round(x));
  if (!out.length) fail(400, 'Give at least one alert threshold');
  return out.sort((a, b) => a - b);
}

async function readLines(db, projectId, v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail(400, 'lines must be a list');
  if (v.length > MAX_LINES) fail(400, `At most ${MAX_LINES} epic or component budgets`);
  const lines = v.map((l) => {
    if (!l || typeof l !== 'object') fail(400, 'Each line needs targetType, targetId and hours');
    const targetType =
      l.targetType === 'epic' || l.targetType === 'component' ? l.targetType : fail(400, 'targetType must be epic or component');
    const hours = num(l.hours, { name: 'Hours', min: 0.01, max: 1e7 });
    if (hours === null || hours === undefined) fail(400, 'Hours is required on each line');
    return { targetType, targetId: String(l.targetId || ''), hours };
  });
  const seen = new Set();
  for (const l of lines) {
    const k = `${l.targetType}:${l.targetId}`;
    if (seen.has(k)) fail(400, 'Each epic or component can have only one budget');
    seen.add(k);
  }
  const epics = lines.filter((l) => l.targetType === 'epic').map((l) => l.targetId);
  const comps = lines.filter((l) => l.targetType === 'component').map((l) => l.targetId);
  if (epics.length) {
    const ok = await db.all(
      `SELECT id FROM issues WHERE project_id = ? AND type = 'epic' AND deleted_at IS NULL AND id IN (${placeholders(epics.length)})`,
      [projectId, ...epics],
    );
    if (ok.length !== epics.length) fail(400, 'An epic in the list is not in this project');
  }
  if (comps.length) {
    const ok = await db.all(`SELECT id FROM components WHERE project_id = ? AND id IN (${placeholders(comps.length)})`, [
      projectId,
      ...comps,
    ]);
    if (ok.length !== comps.length) fail(400, 'A component in the list is not in this project');
  }
  return lines;
}

/** Load work logs by id with their project; checks the caller may change each one. */
async function editableLogs(c, ids) {
  const db = c.env.db;
  const me = c.get('user');
  const rows = await db.all(
    `SELECT w.id, w.user_id, w.work_date, i.project_id FROM worklogs w JOIN issues i ON i.id = w.issue_id WHERE i.deleted_at IS NULL AND w.id IN (${placeholders(ids.length)})`,
    ids,
  );
  if (rows.length !== ids.length) fail(404, 'Work log not found');
  const projects = new Map();
  for (const pid of new Set(rows.map((r) => r.project_id))) projects.set(pid, await projectAccess(c, pid, 'view'));
  for (const r of rows) {
    const a = projects.get(r.project_id);
    if (r.user_id !== me.id && !a.canAdmin) fail(403, 'You can only change your own work logs');
    if (a.guest) fail(403, 'Your guest access does not allow this');
  }
  await assertWeeksOpen(
    db,
    me,
    rows.map((r) => ({ userId: r.user_id, date: r.work_date })),
  ); // approved weeks are locked
  return { rows, projects };
}

async function setBillable(c, ids, billable) {
  const db = c.env.db;
  const { projects } = await editableLogs(c, ids);
  await db.run(`UPDATE worklogs SET billable = ? WHERE id IN (${placeholders(ids.length)})`, [billable ? 1 : 0, ...ids]);
  const nowMs = clock(c.env);
  for (const a of projects.values()) await checkBudgetAlerts(db, a.project, { nowMs, actorId: c.get('user').id });
  return ids.length;
}

export function registerBudgets(app) {
  app.get('/api/projects/:key/budget', async (c) => {
    const a = await budgetAccess(c);
    const db = c.env.db;
    const nowMs = clock(c.env);
    const [burn, rates] = await Promise.all([computeBurn(db, a.project, { nowMs }), a.canAdmin ? loadRates(db, a.project.id) : []]);
    const view = forViewer(burn, a);
    return c.json({
      budget: view ? view.budget : null,
      burn: view,
      canAdmin: a.canAdmin,
      ...(a.canAdmin ? { rates: rates.map(rateOut) } : {}),
    });
  });

  app.put('/api/projects/:key/budget', async (c) => {
    const a = await budgetAccess(c, 'admin');
    const db = c.env.db;
    const b = await body(c);
    const kind = BUDGET_KINDS.includes(b.kind) ? b.kind : fail(400, 'Budget type must be hours or money');
    const amount = num(b.amount, { name: 'Budget', min: 0.01, max: 1e12 });
    if (amount === null || amount === undefined) fail(400, 'Budget amount is required');
    const currency =
      kind === 'money' ? (str(b.currency, { max: 3, name: 'Currency' }) || DEFAULT_CURRENCY).toUpperCase() : DEFAULT_CURRENCY;
    if (!/^[A-Z]{3}$/.test(currency)) fail(400, 'Currency must be a 3-letter code such as CAD');
    const startDate = isoDate(b.startDate, 'Start date') || null;
    const endDate = isoDate(b.endDate, 'End date') || null;
    if (startDate && endDate && endDate < startDate) fail(400, 'End date must be on or after the start date');
    const thresholds = readThresholds(b.thresholds);
    const lines = await readLines(db, a.project.id, b.lines);
    const old = await db.get('SELECT kind, amount FROM project_budgets WHERE project_id = ?', [a.project.id]);
    const t = now();
    const user = c.get('user');
    const stmts = [
      old
        ? {
            sql: 'UPDATE project_budgets SET kind = ?, amount = ?, currency = ?, start_date = ?, end_date = ?, thresholds = ?, updated_at = ? WHERE project_id = ?',
            params: [kind, amount, currency, startDate, endDate, JSON.stringify(thresholds), t, a.project.id],
          }
        : {
            sql: 'INSERT INTO project_budgets (project_id, kind, amount, currency, start_date, end_date, thresholds, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            params: [a.project.id, kind, amount, currency, startDate, endDate, JSON.stringify(thresholds), user.id, t, t],
          },
      { sql: 'DELETE FROM budget_lines WHERE project_id = ?', params: [a.project.id] },
      ...lines.map((l) => ({
        sql: 'INSERT INTO budget_lines (id, project_id, target_type, target_id, hours, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        params: [uuid(), a.project.id, l.targetType, l.targetId, l.hours, t],
      })),
      audit(user.id, old ? 'budget.updated' : 'budget.created', 'project', a.project.id, { kind, thresholds }),
    ];
    // a new amount or type starts the alerts again
    if (old && (old.kind !== kind || Number(old.amount) !== amount))
      stmts.push({ sql: 'DELETE FROM budget_alerts WHERE project_id = ?', params: [a.project.id] });
    await db.batch(stmts);
    await checkBudgetAlerts(db, a.project, { nowMs: clock(c.env), actorId: user.id });
    return c.json({ budget: budgetOut(await db.get('SELECT * FROM project_budgets WHERE project_id = ?', [a.project.id])) });
  });

  app.delete('/api/projects/:key/budget', async (c) => {
    const a = await budgetAccess(c, 'admin');
    await c.env.db.batch([
      { sql: 'DELETE FROM project_budgets WHERE project_id = ?', params: [a.project.id] },
      { sql: 'DELETE FROM budget_lines WHERE project_id = ?', params: [a.project.id] },
      { sql: 'DELETE FROM budget_alerts WHERE project_id = ?', params: [a.project.id] },
      audit(c.get('user').id, 'budget.deleted', 'project', a.project.id, null),
    ]);
    return c.json({ ok: true });
  });

  app.post('/api/projects/:key/budget/rates', async (c) => {
    const a = await budgetAccess(c, 'admin');
    const db = c.env.db;
    const b = await body(c);
    const scope = RATE_SCOPES.includes(b.scope) ? b.scope : fail(400, 'Rate scope must be default, role or person');
    const rate = num(b.rate, { name: 'Rate', min: 0, max: 1e6 });
    if (rate === null || rate === undefined) fail(400, 'Rate is required');
    const effectiveFrom = isoDate(b.effectiveFrom, 'Effective from') || '2000-01-01';
    let role = null;
    let userId = null;
    if (scope === 'role') {
      role = [...MEMBER_ROLES, ...GUEST_LEVELS].includes(b.role) ? b.role : fail(400, 'Role must be a project member role');
    } else if (scope === 'person') {
      userId = String(b.userId || '');
      const u = await db.get('SELECT id FROM users WHERE id = ?', [userId]);
      if (!u) fail(400, 'Person not found');
    }
    const id = uuid();
    const t = now();
    await db.batch([
      {
        sql: 'INSERT INTO budget_rates (id, project_id, scope, role, user_id, rate, effective_from, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        params: [id, a.project.id, scope, role, userId, rate, effectiveFrom, t],
      },
      audit(c.get('user').id, 'budget.rate_added', 'project', a.project.id, { scope, role, userId, effectiveFrom }),
    ]);
    await checkBudgetAlerts(db, a.project, { nowMs: clock(c.env), actorId: c.get('user').id });
    const row = await db.get('SELECT r.*, u.name AS user_name FROM budget_rates r LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ?', [
      id,
    ]);
    return c.json({ rate: rateOut(row) }, 201);
  });

  app.delete('/api/projects/:key/budget/rates/:id', async (c) => {
    const a = await budgetAccess(c, 'admin');
    const r = await c.env.db.run('DELETE FROM budget_rates WHERE id = ? AND project_id = ?', [c.req.param('id'), a.project.id]);
    if (!r.changes) fail(404, 'Rate not found');
    return c.json({ ok: true });
  });

  app.get('/api/projects/:key/budget/export.csv', async (c) => {
    const a = await budgetAccess(c, 'admin');
    const db = c.env.db;
    const day = await today(c);
    const budget = await db.get('SELECT currency, start_date, end_date FROM project_budgets WHERE project_id = ?', [a.project.id]);
    const to = isoDate(c.req.query('to'), 'To') || (budget?.end_date && budget.end_date < day ? budget.end_date : day);
    const from = isoDate(c.req.query('from'), 'From') || budget?.start_date || addDays(to, -29);
    if (to < from) fail(400, 'To must be on or after From');
    if ((Date.parse(to) - Date.parse(from)) / 864e5 + 1 > MAX_EXPORT_DAYS) fail(400, `At most ${MAX_EXPORT_DAYS} days at a time`);
    const rows = await billableRows(db, a.project, from, to);
    const currency = budget?.currency || DEFAULT_CURRENCY;
    const lines = [
      ['Week starting', 'Person', 'Email', 'Billable hours', 'Hours without a rate', 'Cost', 'Currency'].map(csvCell).join(','),
    ];
    for (const r of rows) lines.push([r.week, r.name, r.email, r.hours, r.unrated, r.cost, currency].map(csvCell).join(','));
    return c.body(lines.join('\n'), 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${a.project.key.toLowerCase()}-billable-${from}-to-${to}.csv"`,
    });
  });

  app.patch('/api/worklogs/:id', async (c) => {
    const b = await body(c);
    if (typeof b.billable !== 'boolean') fail(400, 'billable must be true or false');
    await setBillable(c, [c.req.param('id')], b.billable);
    return c.json({ ok: true });
  });

  app.post('/api/worklogs/billable', async (c) => {
    const b = await body(c);
    if (typeof b.billable !== 'boolean') fail(400, 'billable must be true or false');
    const ids = Array.isArray(b.ids) ? [...new Set(b.ids.map(String))] : [];
    if (!ids.length) fail(400, 'Choose at least one work log');
    if (ids.length > MAX_IDS) fail(400, `At most ${MAX_IDS} work logs at a time`);
    return c.json({ ok: true, changed: await setBillable(c, ids, b.billable) });
  });
}
