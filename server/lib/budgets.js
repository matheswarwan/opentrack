// Project budgets, rates and burn (migration 0026; routes in server/routes/budgets.js).
//
// A budget is hours or money. Billable work logged inside the budget's dates counts against it; non-billable work is
// shown apart. Money = billable hours x the rate in effect on the work date: the newest rate with effective_from on
// or before that date, a person's own rate first, then their project member role's rate, then the project default.
// Work with no rate costs nothing and is counted as unrated hours.
//
// Forecast: remaining hours = the open issues' estimates minus hours already logged on them (never below 0); burn
// rate = billable hours per week over the last 4 weeks (or since the first billable log when that is shorter, at
// least a week). Forecast at completion = used + remaining (money: remaining hours x the recent average rate).
//
// Who sees what: project admins and workspace admins get everything; other members get hours and percentages only
// (no amounts of money, rates or costs); guests get nothing (the routes 404).
import { noticeStmts } from './notifications.js';
import { DAY, addDays, mondayOf } from './time.js';
import { parseList } from './json.js';

export const BUDGET_KINDS = ['hours', 'money'];
export const RATE_SCOPES = ['default', 'role', 'person'];
export const DEFAULT_THRESHOLDS = [80, 100];
export const DEFAULT_CURRENCY = 'CAD';
export const BURN_WEEKS = 4;
const MAX_CHART_WEEKS = 156;

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (d) => Date.parse(`${d}T00:00:00.000Z`);

function parseThresholds(s) {
  const v = parseList(s);
  if (v.length)
    return v
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
  return [...DEFAULT_THRESHOLDS];
}

export function budgetOut(row) {
  if (!row) return null;
  return {
    kind: row.kind,
    amount: Number(row.amount),
    currency: row.currency || DEFAULT_CURRENCY,
    startDate: row.start_date || null,
    endDate: row.end_date || null,
    thresholds: parseThresholds(row.thresholds),
    updatedAt: row.updated_at,
  };
}

export const rateOut = (r) => ({
  id: r.id,
  scope: r.scope,
  role: r.role || null,
  user: r.user_id ? { id: r.user_id, name: r.user_name || 'Former user' } : null,
  rate: Number(r.rate),
  effectiveFrom: r.effective_from,
});

/**
 * Rate lookup: (userId, date) -> rate or null. rates: budget_rates rows; roles: Map userId -> project member role.
 */
export function rateResolver(rates, roles = new Map()) {
  const sorted = [...rates].sort((a, b) => b.effective_from.localeCompare(a.effective_from)); // newest first
  const pick = (list, date) => list.find((r) => r.effective_from <= date) || null;
  const person = new Map();
  const role = new Map();
  const def = [];
  for (const r of sorted) {
    if (r.scope === 'person' && r.user_id) (person.get(r.user_id) || person.set(r.user_id, []).get(r.user_id)).push(r);
    else if (r.scope === 'role' && r.role) (role.get(r.role) || role.set(r.role, []).get(r.role)).push(r);
    else if (r.scope === 'default') def.push(r);
  }
  return (userId, date) => {
    const p = person.has(userId) ? pick(person.get(userId), date) : null;
    if (p) return Number(p.rate);
    const ro = roles.get(userId);
    const q = ro && role.has(ro) ? pick(role.get(ro), date) : null;
    if (q) return Number(q.rate);
    const d = pick(def, date);
    return d ? Number(d.rate) : null;
  };
}

/** The project's rates (with person names). */
export function loadRates(db, projectId) {
  return db.all(
    `SELECT r.*, u.name AS user_name FROM budget_rates r LEFT JOIN users u ON u.id = r.user_id WHERE r.project_id = ? ORDER BY r.scope, r.effective_from`,
    [projectId],
  );
}

/** Project member roles of the people with work logged, needed only when there are role rates. */
async function memberRoles(db, projectId, rates) {
  if (!rates.some((r) => r.scope === 'role')) return new Map();
  const rows = await db.all('SELECT user_id, role FROM project_members WHERE project_id = ?', [projectId]);
  return new Map(rows.map((r) => [r.user_id, r.role]));
}

/**
 * Burn for one project, as of a day (default today). Returns null when the project has no budget.
 * opts: { nowMs, asOf (YYYY-MM-DD), usageOnly (skip issues, epics, components and forecast: for alerts) }.
 * Everything is in the result, money included; use forViewer() before sending it.
 */
export async function computeBurn(db, project, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const asOf = opts.asOf || dayStr(nowMs);
  const row = await db.get('SELECT * FROM project_budgets WHERE project_id = ?', [project.id]);
  if (!row) return null;
  const budget = budgetOut(row);
  const pid = project.id;
  const [rates, logs, lines, issues] = await Promise.all([
    budget.kind === 'money' || !opts.usageOnly ? loadRates(db, pid) : [],
    db.all(
      `SELECT w.issue_id, w.user_id, u.name AS user_name, w.work_date, w.billable, CAST(SUM(w.hours) AS DOUBLE PRECISION) AS hours
         FROM worklogs w JOIN issues i ON i.id = w.issue_id LEFT JOIN users u ON u.id = w.user_id
        WHERE i.project_id = ? AND i.deleted_at IS NULL AND w.work_date <= ?
        GROUP BY w.issue_id, w.user_id, u.name, w.work_date, w.billable`,
      [pid, asOf],
    ),
    opts.usageOnly ? [] : db.all('SELECT * FROM budget_lines WHERE project_id = ? ORDER BY created_at', [pid]),
    opts.usageOnly
      ? []
      : db.all(
          `SELECT i.id, i.key, i.title, i.type, i.parent_id, i.estimate_hours, s.category FROM issues i JOIN statuses s ON s.id = i.status_id
        WHERE i.project_id = ? AND i.deleted_at IS NULL`,
          [pid],
        ),
  ]);
  const roles = await memberRoles(db, pid, rates);
  const rateOf = rateResolver(rates, roles);
  const inWindow = (d) => (!budget.startDate || d >= budget.startDate) && (!budget.endDate || d <= budget.endDate);
  const money = budget.kind === 'money';

  // usage
  let hours = 0;
  let nonBillable = 0;
  let cost = 0;
  let unrated = 0;
  const weeks = new Map();
  const people = new Map();
  const byIssue = new Map(); // billable hours and cost in the window
  const loggedAll = new Map(); // every hour on the issue (for the remaining estimate)
  let firstBillable = null;
  for (const l of logs) {
    const h = Number(l.hours) || 0;
    loggedAll.set(l.issue_id, (loggedAll.get(l.issue_id) || 0) + h);
    if (!inWindow(l.work_date)) continue;
    const pk = l.user_id || 'former';
    if (!people.has(pk))
      people.set(pk, { id: l.user_id || null, name: l.user_name || 'Former user', hours: 0, nonBillableHours: 0, cost: 0 });
    const p = people.get(pk);
    if (!Number(l.billable)) {
      nonBillable += h;
      p.nonBillableHours += h;
      continue;
    }
    const rate = rateOf(l.user_id, l.work_date);
    const c = rate === null ? 0 : h * rate;
    if (rate === null) unrated += h;
    hours += h;
    cost += c;
    p.hours += h;
    p.cost += c;
    const wk = mondayOf(l.work_date);
    if (!weeks.has(wk)) weeks.set(wk, { week: wk, hours: 0, cost: 0 });
    weeks.get(wk).hours += h;
    weeks.get(wk).cost += c;
    const bi = byIssue.get(l.issue_id) || { hours: 0, cost: 0 };
    bi.hours += h;
    bi.cost += c;
    byIssue.set(l.issue_id, bi);
    if (!firstBillable || l.work_date < firstBillable) firstBillable = l.work_date;
  }
  const used = money ? cost : hours;
  const pctUsed = budget.amount > 0 ? r2((used / budget.amount) * 100) : 0;
  const usage = {
    hours: r2(hours),
    nonBillableHours: r2(nonBillable),
    cost: r2(cost),
    unratedHours: r2(unrated),
    value: r2(used),
    remaining: r2(budget.amount - used),
    pctUsed,
  };
  if (opts.usageOnly) return { budget, asOf, usage };

  // burn rate: billable hours per week over the last BURN_WEEKS weeks (shorter when the work started later)
  const winStart = addDays(asOf, -(BURN_WEEKS * 7 - 1));
  let recentH = 0;
  let recentC = 0;
  for (const l of logs) {
    if (!Number(l.billable) || !inWindow(l.work_date) || l.work_date < winStart) continue;
    const h = Number(l.hours) || 0;
    const rate = rateOf(l.user_id, l.work_date);
    recentH += h;
    recentC += rate === null ? 0 : h * rate;
  }
  const spanStart = firstBillable && firstBillable > winStart ? firstBillable : winStart;
  const spanDays = Math.max(7, Math.round((dayMs(asOf) - dayMs(spanStart)) / DAY) + 1);
  const burnHours = firstBillable ? (recentH / spanDays) * 7 : 0; // hours per week
  const avgRate = recentH > 0 && recentC > 0 ? recentC / recentH : hours > 0 && cost > 0 ? cost / hours : rateOf(null, asOf);

  // epics (sub-tasks roll up through their parent, as the estimates report) and the remaining estimate
  const byId = new Map(issues.map((i) => [i.id, i]));
  const epicOf = (i) => {
    if (i.type === 'epic') return i;
    let p = i.parent_id ? byId.get(i.parent_id) : null;
    if (p && p.type !== 'epic' && p.parent_id) p = byId.get(p.parent_id);
    return p && p.type === 'epic' ? p : null;
  };
  const epicLines = new Map(lines.filter((l) => l.target_type === 'epic').map((l) => [l.target_id, Number(l.hours)]));
  const epics = new Map();
  const epicRow = (e) => {
    const k = e ? e.id : 'none';
    if (!epics.has(k))
      epics.set(k, {
        id: e?.id || null,
        key: e?.key || null,
        title: e ? e.title : 'Issues without an epic',
        hours: 0,
        cost: 0,
        remainingHours: 0,
        budgetHours: e && epicLines.has(e.id) ? epicLines.get(e.id) : null,
      });
    return epics.get(k);
  };
  let remaining = 0;
  for (const i of issues) {
    const b = byIssue.get(i.id);
    const open = i.category !== 'done' && i.type !== 'epic';
    const left =
      open && i.estimate_hours !== null && i.estimate_hours !== undefined
        ? Math.max(0, Number(i.estimate_hours) - (loggedAll.get(i.id) || 0))
        : 0;
    remaining += left;
    if (!b && !left && !(i.type === 'epic' && epicLines.has(i.id))) continue;
    const g = epicRow(epicOf(i));
    if (b) {
      g.hours += b.hours;
      g.cost += b.cost;
    }
    g.remainingHours += left;
  }
  const epicList = [...epics.values()].map((e) => ({
    ...e,
    hours: r2(e.hours),
    cost: r2(e.cost),
    remainingHours: r2(e.remainingHours),
    pctUsed: e.budgetHours ? r2((e.hours / e.budgetHours) * 100) : null,
  }));
  epicList.sort((a, b) => (a.key === null) - (b.key === null) || b.hours - a.hours || String(a.key).localeCompare(String(b.key)));

  // components with an hours budget
  let components = [];
  const compLines = lines.filter((l) => l.target_type === 'component');
  if (compLines.length) {
    const rows = await db.all(
      `SELECT c.id, c.name, ic.issue_id FROM components c LEFT JOIN issue_components ic ON ic.component_id = c.id WHERE c.project_id = ?`,
      [pid],
    );
    const names = new Map();
    const hoursBy = new Map();
    for (const r of rows) {
      names.set(r.id, r.name);
      if (r.issue_id) hoursBy.set(r.id, (hoursBy.get(r.id) || 0) + (byIssue.get(r.issue_id)?.hours || 0));
    }
    components = compLines
      .filter((l) => names.has(l.target_id))
      .map((l) => {
        const h = hoursBy.get(l.target_id) || 0;
        return {
          id: l.target_id,
          name: names.get(l.target_id),
          hours: r2(h),
          budgetHours: Number(l.hours),
          pctUsed: Number(l.hours) > 0 ? r2((h / Number(l.hours)) * 100) : null,
        };
      });
  }

  // forecast
  const remainingValue = money ? (avgRate ? remaining * avgRate : 0) : remaining;
  const atCompletion = used + remainingValue;
  const weeksToFinish = remaining <= 0 ? 0 : burnHours > 0 ? remaining / burnHours : null;
  const finishDate = weeksToFinish === null ? null : addDays(asOf, Math.ceil(weeksToFinish * 7));
  const burnValue = money ? burnHours * (avgRate || 0) : burnHours;
  const left = budget.amount - used;
  const exhaustDate = left <= 0 ? asOf : burnValue > 0 ? addDays(asOf, Math.ceil((left / burnValue) * 7)) : null;
  const forecast = {
    remainingHours: r2(remaining),
    remainingValue: r2(remainingValue),
    burnRateHours: r2(burnHours),
    burnRateValue: r2(burnValue),
    averageRate: avgRate ? r2(avgRate) : null,
    atCompletion: r2(atCompletion),
    atCompletionPct: budget.amount > 0 ? r2((atCompletion / budget.amount) * 100) : 0,
    finishDate,
    exhaustDate,
    overBudget: atCompletion > budget.amount + 1e-9,
    finishAfterEnd: Boolean(budget.endDate && finishDate && finishDate > budget.endDate),
    noEstimates: !issues.some((i) => i.estimate_hours !== null && i.estimate_hours !== undefined && i.type !== 'epic'),
  };

  // weekly series and the burn-up chart (budget unit and hours)
  const weekList = [...weeks.values()]
    .sort((a, b) => a.week.localeCompare(b.week))
    .map((w) => ({ week: w.week, hours: r2(w.hours), cost: r2(w.cost) }));
  const firstWeek = mondayOf(budget.startDate || firstBillable || asOf);
  const nowWeek = mondayOf(asOf);
  let lastWeek = nowWeek;
  for (const d of [budget.endDate, finishDate]) if (d && mondayOf(d) > lastWeek) lastWeek = mondayOf(d);
  const labels = [];
  for (let w = firstWeek; w <= lastWeek && labels.length < MAX_CHART_WEEKS; w = addDays(w, 7)) labels.push(w);
  const finishWeek = finishDate ? mondayOf(finishDate) : null;
  const series = (unitOf, total, target) => {
    let cum = 0;
    const actual = [];
    const fc = [];
    let nowCum = 0;
    for (const w of labels) {
      const wk = weeks.get(w);
      if (w <= nowWeek) {
        cum += wk ? unitOf(wk) : 0;
        actual.push(r2(cum));
        nowCum = cum;
      } else actual.push(null);
    }
    const nowIdx = labels.indexOf(nowWeek);
    const finIdx = finishWeek ? labels.indexOf(finishWeek) : -1;
    labels.forEach((w, i) => {
      if (nowIdx < 0 || i < nowIdx || finIdx < 0 || i > finIdx) fc.push(null);
      else if (finIdx === nowIdx) fc.push(r2(total));
      else fc.push(r2(nowCum + ((total - nowCum) * (i - nowIdx)) / (finIdx - nowIdx)));
    });
    return { actual, forecast: fc, budget: target === null ? null : labels.map(() => target) };
  };
  const chart = {
    labels,
    value: series((w) => (money ? w.cost : w.hours), atCompletion, budget.amount),
    hours: series((w) => w.hours, hours + remaining, money ? null : budget.amount),
  };

  const peopleList = [...people.values()]
    .map((p) => ({ ...p, hours: r2(p.hours), nonBillableHours: r2(p.nonBillableHours), cost: r2(p.cost) }))
    .sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name));
  return {
    budget,
    asOf,
    usage,
    forecast,
    weeks: weekList,
    people: peopleList,
    epics: epicList,
    components,
    chart,
    lines: lines.map((l) => ({ id: l.id, targetType: l.target_type, targetId: l.target_id, hours: Number(l.hours) })),
  };
}

/**
 * What a viewer may see. Project and workspace admins: everything. Members: hours and percentages only.
 */
export function forViewer(burn, { canAdmin }) {
  if (!burn || canAdmin) return burn;
  const money = burn.budget.kind === 'money';
  const { amount, currency, ...budgetRest } = burn.budget;
  return {
    budget: money ? budgetRest : { ...budgetRest, amount },
    asOf: burn.asOf,
    hoursOnly: true,
    usage: {
      hours: burn.usage.hours,
      nonBillableHours: burn.usage.nonBillableHours,
      pctUsed: burn.usage.pctUsed,
      ...(money ? {} : { value: burn.usage.value, remaining: burn.usage.remaining }),
    },
    forecast: {
      remainingHours: burn.forecast.remainingHours,
      burnRateHours: burn.forecast.burnRateHours,
      atCompletionPct: burn.forecast.atCompletionPct,
      finishDate: burn.forecast.finishDate,
      exhaustDate: burn.forecast.exhaustDate,
      overBudget: burn.forecast.overBudget,
      finishAfterEnd: burn.forecast.finishAfterEnd,
      noEstimates: burn.forecast.noEstimates,
      ...(money ? {} : { atCompletion: burn.forecast.atCompletion }),
    },
    weeks: burn.weeks.map((w) => ({ week: w.week, hours: w.hours })),
    people: burn.people.map((p) => ({ id: p.id, name: p.name, hours: p.hours, nonBillableHours: p.nonBillableHours })),
    epics: burn.epics.map(({ cost, ...e }) => e),
    components: burn.components,
    chart: { labels: burn.chart.labels, hours: burn.chart.hours },
    lines: burn.lines,
  };
}

/**
 * Status report snapshot: percentages and hours only (members read reports; guests may, when shared).
 * null when the project has no budget.
 */
export async function budgetSnapshot(db, project, { nowMs, asOf } = {}) {
  const b = await computeBurn(db, project, { nowMs, asOf });
  if (!b) return null;
  return {
    source: 'budget',
    kind: b.budget.kind,
    thresholds: b.budget.thresholds,
    pctUsed: b.usage.pctUsed,
    forecastPct: b.forecast.atCompletionPct,
    hoursUsed: b.usage.hours,
    remainingHours: b.forecast.remainingHours,
    finishDate: b.forecast.finishDate,
    endDate: b.budget.endDate,
    finishAfterEnd: b.forecast.finishAfterEnd,
    ...(b.budget.kind === 'hours' ? { budgetHours: b.budget.amount } : {}),
  };
}

/** Budget RAG from a snapshot: amber at the first threshold, red at 100% or a forecast more than 10% over. */
export function budgetRag(s) {
  const first = s.thresholds?.[0] ?? DEFAULT_THRESHOLDS[0];
  const value = s.pctUsed >= 100 || s.forecastPct > 110 ? 'red' : s.pctUsed >= first || s.forecastPct > 100 ? 'amber' : 'green';
  const what =
    s.kind === 'hours'
      ? `${s.hoursUsed} of ${s.budgetHours} budgeted hours used (${Math.round(s.pctUsed)}%)`
      : `${Math.round(s.pctUsed)}% of the budget used`;
  const why = [what, `Forecast at completion: ${Math.round(s.forecastPct)}% of the budget`];
  if (s.finishAfterEnd) why.push(`Projected finish ${s.finishDate} is after the budget end date ${s.endDate}`);
  return { value, why };
}

/**
 * Notify project admins once per threshold crossed. Call after anything that changes usage (work logged, billable
 * changed, budget or rates saved). Returns the thresholds announced now. Never throws.
 */
export async function checkBudgetAlerts(db, project, { nowMs = Date.now(), actorId = null } = {}) {
  try {
    const b = await computeBurn(db, project, { nowMs, usageOnly: true });
    if (!b) return [];
    const crossed = b.budget.thresholds.filter((t) => b.usage.pctUsed >= t);
    if (!crossed.length) return [];
    const done = new Set(
      (await db.all('SELECT threshold FROM budget_alerts WHERE project_id = ?', [project.id])).map((r) => Number(r.threshold)),
    );
    const fresh = crossed.filter((t) => !done.has(t));
    if (!fresh.length) return [];
    const t = new Date(nowMs).toISOString();
    const announced = [];
    for (const th of fresh) {
      // the insert decides: two requests at once announce a threshold only once
      const r = await db.run(
        'INSERT INTO budget_alerts (project_id, threshold, used_pct, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (project_id, threshold) DO NOTHING',
        [project.id, th, b.usage.pctUsed, t],
      );
      if (r.changes === 1) announced.push(th);
    }
    if (!announced.length) return [];
    const admins = await db.all(
      `SELECT u.id FROM users u WHERE u.status = 'active' AND u.is_system = 0 AND u.role <> 'guest'
         AND (u.id = ? OR u.id IN (SELECT user_id FROM project_members WHERE project_id = ? AND role = 'admin'))`,
      [project.lead_id || '', project.id],
    );
    const top = Math.max(...announced);
    const message = `Budget for ${project.name}: ${Math.round(b.usage.pctUsed)}% used, past the ${top}% alert.`;
    const link = `/projects/${project.key}/reports`;
    await db.batch(
      noticeStmts(admins.map((a) => ({ userId: a.id, type: 'budget', actorId, message, at: t, projectId: project.id, link }))),
    );
    return announced;
  } catch (e) {
    console.error('budget alerts', e);
    return [];
  }
}

/** Rows for the billable CSV: one per person and week, with hours and cost (rates in effect on each work date). */
export async function billableRows(db, project, from, to) {
  const [rates, logs] = await Promise.all([
    loadRates(db, project.id),
    db.all(
      `SELECT w.user_id, u.name AS user_name, u.email, w.work_date, CAST(SUM(w.hours) AS DOUBLE PRECISION) AS hours
         FROM worklogs w JOIN issues i ON i.id = w.issue_id LEFT JOIN users u ON u.id = w.user_id
        WHERE i.project_id = ? AND i.deleted_at IS NULL AND w.billable = 1 AND w.work_date >= ? AND w.work_date <= ?
        GROUP BY w.user_id, u.name, u.email, w.work_date`,
      [project.id, from, to],
    ),
  ]);
  const rateOf = rateResolver(rates, await memberRoles(db, project.id, rates));
  const out = new Map();
  for (const l of logs) {
    const wk = mondayOf(l.work_date);
    const k = `${wk}|${l.user_id || ''}`;
    if (!out.has(k)) out.set(k, { week: wk, name: l.user_name || 'Former user', email: l.email || '', hours: 0, cost: 0, unrated: 0 });
    const o = out.get(k);
    const h = Number(l.hours) || 0;
    const rate = rateOf(l.user_id, l.work_date);
    o.hours += h;
    if (rate === null) o.unrated += h;
    else o.cost += h * rate;
  }
  return [...out.values()]
    .sort((a, b) => a.week.localeCompare(b.week) || a.name.localeCompare(b.name))
    .map((o) => ({ ...o, hours: r2(o.hours), cost: r2(o.cost), unrated: r2(o.unrated) }));
}
