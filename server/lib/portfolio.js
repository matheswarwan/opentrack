// Portfolio: one row per project the viewer can see, with its health and the numbers behind it.
// Route: GET /api/portfolio (server/routes/portfolio.js). Page: /portfolio (src/views/PortfolioPage.vue).
//
// Every number is aggregated across projects with GROUP BY over the visible projects (visibleProjectsSql), so the
// request uses the same handful of statements whether there are 3 projects or 300 (test/portfolio.test.js).
// Issues in the Trash are left out everywhere.
//
// Health: the latest published status report's Overall RAG (guests: reports shared with guests only). Without one,
// a "computed" RAG from the status report rules (server/lib/statusReports.js suggestRag) over the same numbers,
// without the sprint burndown (it needs per-project history reads).
import { rateResolver } from './budgets.js';
import { DAY, daysBetween } from './time.js';
import { visibleProjectsSql, isGuest } from './access.js';
import { reportBrief, suggestRag } from './statusReports.js';
import { placeholders, chunks } from '../db/sql.js';

export const MILESTONE_DAYS = 90; // the Milestones strip
export const SOON_DAYS = 14; // the "milestones in the next 14 days" tile
const HIGH = "('highest', 'high')";

const dayStr = (t) => new Date(t).toISOString().slice(0, 10);
const num = (v) => Number(v) || 0;
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * Budget % used per project: { [projectId]: { kind, usedPct, used, amount, currency } }.
 * Reads the budgets tables (migration 0026, built separately); returns {} when they do not exist yet, so the
 * portfolio works with or without budgets. Hours budgets: billable hours logged within the budget dates against the
 * amount. Money budgets use the rate rules from server/lib/budgets.js.
 */
/** Fill used/usedPct for money budgets: billable hours x the rate in effect on each work date (budgets.js rules). */
async function moneyUsed(db, out) {
  const ids = Object.keys(out).filter((id) => out[id].kind === 'money');
  for (const part of chunks(ids)) {
    const marks = placeholders(part.length);
    const [logs, rates, roles] = await Promise.all([
      db.all(
        `SELECT i.project_id, w.user_id, w.work_date, CAST(SUM(w.hours) AS DOUBLE PRECISION) AS hours
           FROM project_budgets b JOIN issues i ON i.project_id = b.project_id AND i.deleted_at IS NULL
           JOIN worklogs w ON w.issue_id = i.id AND w.billable = 1
                AND (b.start_date IS NULL OR w.work_date >= b.start_date) AND (b.end_date IS NULL OR w.work_date <= b.end_date)
          WHERE b.project_id IN (${marks})
          GROUP BY i.project_id, w.user_id, w.work_date`,
        part,
      ),
      db.all(`SELECT * FROM budget_rates WHERE project_id IN (${marks})`, part),
      db.all(`SELECT project_id, user_id, role FROM project_members WHERE project_id IN (${marks})`, part),
    ]);
    for (const id of part) {
      const rateOf = rateResolver(
        rates.filter((r) => r.project_id === id),
        new Map(roles.filter((r) => r.project_id === id).map((r) => [r.user_id, r.role])),
      );
      let cost = 0;
      for (const l of logs) if (l.project_id === id) cost += num(l.hours) * (rateOf(l.user_id, l.work_date) || 0);
      out[id].used = r2(cost);
      out[id].usedPct = pct(cost, out[id].amount);
    }
  }
}

export async function budgetSummaries(db, projectIds) {
  const ids = [...new Set(projectIds.filter(Boolean))];
  if (!ids.length) return {};
  const out = {};
  try {
    for (const part of chunks(ids)) {
      const rows = await db.all(
        `SELECT b.project_id, b.kind, b.amount, b.currency,
                CAST(COALESCE(SUM(w.hours), 0) AS DOUBLE PRECISION) AS hours
           FROM project_budgets b
           LEFT JOIN issues i ON i.project_id = b.project_id AND i.deleted_at IS NULL
           LEFT JOIN worklogs w ON w.issue_id = i.id AND w.billable = 1
                AND (b.start_date IS NULL OR w.work_date >= b.start_date) AND (b.end_date IS NULL OR w.work_date <= b.end_date)
          WHERE b.project_id IN (${placeholders(part.length)})
          GROUP BY b.project_id, b.kind, b.amount, b.currency`,
        part,
      );
      for (const r of rows) {
        const amount = num(r.amount);
        const hours = r2(num(r.hours));
        out[r.project_id] =
          r.kind === 'hours'
            ? { kind: 'hours', amount, used: hours, usedPct: pct(hours, amount), currency: null }
            : { kind: r.kind, amount, used: null, usedPct: null, currency: r.currency || null };
      }
    }
    await moneyUsed(db, out);
  } catch {
    return {}; // no budgets tables (yet)
  }
  return out;
}

/**
 * The portfolio for this user: { today, rows, summary, milestones, budgetShown }. budgetShown: some project has a
 * budget (never for guests: they get no budget field at all).
 * opts.archived: include archived projects. opts.budgets: the budgetSummaries function (tests may swap it).
 */
export async function portfolio(db, user, { archived = false, nowMs = Date.now(), budgets = budgetSummaries } = {}) {
  const guest = isGuest(user);
  const today = dayStr(nowMs);
  const v = visibleProjectsSql(user);
  const where = `${v.sql}${archived ? '' : ' AND p.archived = 0'}`;
  const vp = v.params;

  const [projects, agg, blocked, reports, releases, sprints, logged] = await Promise.all([
    db.all(
      `SELECT p.id, p.key, p.name, p.visibility, p.archived, p.lead_id, p.created_at, p.updated_at, l.name AS lead_name, mm.role AS my_role
         FROM projects p LEFT JOIN users l ON l.id = p.lead_id LEFT JOIN project_members mm ON mm.project_id = p.id AND mm.user_id = ?
        WHERE ${where} ORDER BY p.name`,
      [user.id, ...vp],
    ),
    // work = stories, tasks and bugs (no epics, no sub-tasks), as in the status report; open = not done, no epics
    db.all(
      `SELECT i.project_id,
              CAST(SUM(CASE WHEN i.type NOT IN ('epic', 'subtask') THEN 1 ELSE 0 END) AS INTEGER) AS work,
              CAST(SUM(CASE WHEN i.type NOT IN ('epic', 'subtask') AND s.category = 'done' THEN 1 ELSE 0 END) AS INTEGER) AS work_done,
              CAST(SUM(CASE WHEN i.type NOT IN ('epic', 'subtask') THEN COALESCE(i.story_points, 0) ELSE 0 END) AS DOUBLE PRECISION) AS points,
              CAST(SUM(CASE WHEN i.type NOT IN ('epic', 'subtask') AND s.category = 'done' THEN COALESCE(i.story_points, 0) ELSE 0 END) AS DOUBLE PRECISION) AS points_done,
              CAST(SUM(CASE WHEN i.type <> 'epic' AND s.category <> 'done' THEN 1 ELSE 0 END) AS INTEGER) AS open,
              CAST(SUM(CASE WHEN i.type <> 'epic' AND s.category <> 'done' AND i.due_date IS NOT NULL AND i.due_date < ? THEN 1 ELSE 0 END) AS INTEGER) AS overdue,
              CAST(SUM(CASE WHEN i.type = 'bug' AND s.category <> 'done' AND i.priority IN ${HIGH} THEN 1 ELSE 0 END) AS INTEGER) AS high_bugs,
              CAST(SUM(CASE WHEN i.estimate_hours > 0 THEN i.estimate_hours ELSE 0 END) AS DOUBLE PRECISION) AS estimate,
              CAST(SUM(CASE WHEN i.estimate_hours > 0 AND s.category = 'done' THEN i.estimate_hours ELSE 0 END) AS DOUBLE PRECISION) AS estimate_done,
              MAX(i.updated_at) AS last_activity
         FROM issues i JOIN statuses s ON s.id = i.status_id JOIN projects p ON p.id = i.project_id
        WHERE i.deleted_at IS NULL AND ${where}
        GROUP BY i.project_id`,
      [today, ...vp],
    ),
    // open issues with an open blocker (blocker not done, not in the Trash)
    db.all(
      `SELECT ti.project_id, CAST(COUNT(DISTINCT ti.id) AS INTEGER) AS n
         FROM issue_links bl JOIN issues bi ON bi.id = bl.source_id JOIN statuses bs ON bs.id = bi.status_id
         JOIN issues ti ON ti.id = bl.target_id JOIN statuses ts ON ts.id = ti.status_id JOIN projects p ON p.id = ti.project_id
        WHERE bl.type = 'blocks' AND bi.deleted_at IS NULL AND bs.category <> 'done'
          AND ti.deleted_at IS NULL AND ts.category <> 'done' AND ti.type <> 'epic' AND ${where}
        GROUP BY ti.project_id`,
      vp,
    ),
    // the latest published report per project (guests: shared with guests only)
    db.all(
      `SELECT r.id, r.project_id, r.rag, r.period_start, r.period_end, r.published_at
         FROM status_reports r JOIN projects p ON p.id = r.project_id
        WHERE ${where} AND r.id = (
          SELECT r2.id FROM status_reports r2
           WHERE r2.project_id = r.project_id AND r2.status = 'published'${guest ? ' AND r2.shared_with_guests = 1' : ''}
           ORDER BY r2.period_end DESC, r2.published_at DESC LIMIT 1)`,
      vp,
    ),
    db.all(
      `SELECT r.id, r.project_id, r.name, r.release_date FROM releases r JOIN projects p ON p.id = r.project_id
        WHERE r.status = 'unreleased' AND r.release_date IS NOT NULL AND ${where}
        ORDER BY r.release_date, LOWER(r.name)`,
      vp,
    ),
    db.all(
      `SELECT s.id, s.project_id, s.name, s.start_date, s.end_date FROM sprints s JOIN projects p ON p.id = s.project_id
        WHERE s.state = 'active' AND ${where} ORDER BY s.created_at`,
      vp,
    ),
    // hours logged (for the computed Budget RAG; never for guests)
    guest
      ? []
      : db.all(
          `SELECT i.project_id, CAST(SUM(w.hours) AS DOUBLE PRECISION) AS hours
           FROM worklogs w JOIN issues i ON i.id = w.issue_id JOIN projects p ON p.id = i.project_id
          WHERE i.deleted_at IS NULL AND ${where} GROUP BY i.project_id`,
          vp,
        ),
  ]);
  const budget = guest
    ? {}
    : await budgets(
        db,
        projects.map((p) => p.id),
      );

  const by = (list) => new Map(list.map((r) => [r.project_id, r]));
  const aggBy = by(agg);
  const blockedBy = by(blocked);
  const reportBy = by(reports);
  const loggedBy = by(logged);
  const sprintBy = new Map();
  for (const s of sprints) if (!sprintBy.has(s.project_id)) sprintBy.set(s.project_id, s);
  const releasesBy = new Map();
  for (const r of releases) {
    if (!releasesBy.has(r.project_id)) releasesBy.set(r.project_id, []);
    releasesBy.get(r.project_id).push(r);
  }

  const rows = projects.map((p) => {
    const a = aggBy.get(p.id) || {};
    const work = num(a.work);
    const workDone = num(a.work_done);
    const points = r2(num(a.points));
    const pointsDone = r2(num(a.points_done));
    const counts = { overdue: num(a.overdue), blocked: num(blockedBy.get(p.id)?.n), highBugs: num(a.high_bugs) };
    const rels = releasesBy.get(p.id) || [];
    const next = rels[0] || null;
    const overdueReleases = rels.filter((r) => r.release_date < today);

    let health;
    const report = reportBy.get(p.id);
    if (report) {
      const b = reportBrief(report);
      health = {
        source: 'report',
        value: b.rag.overall || null,
        reportId: report.id,
        periodEnd: report.period_end,
        publishedAt: report.published_at,
        why: [],
      };
    } else {
      const estimate = num(a.estimate);
      const budgetData =
        !guest && estimate > 0
          ? {
              estimateHours: r2(estimate),
              loggedHours: r2(num(loggedBy.get(p.id)?.hours)),
              burn: r2(num(loggedBy.get(p.id)?.hours) / estimate),
              progress: r2(num(a.estimate_done) / estimate),
            }
          : null;
      const rag = suggestRag({ counts, burndown: null, budget: budgetData, overdueReleases: overdueReleases.map((r) => r.name) });
      health = { source: 'computed', value: rag.overall.value, reportId: null, periodEnd: null, publishedAt: null, why: rag.overall.why };
    }

    const sprint = sprintBy.get(p.id);
    const bud = budget[p.id];
    return {
      id: p.id,
      key: p.key,
      name: p.name,
      archived: Boolean(Number(p.archived)),
      visibility: p.visibility,
      lead: p.lead_id ? { id: p.lead_id, name: p.lead_name || 'Former user' } : null,
      mine: p.lead_id === user.id || Boolean(p.my_role),
      health,
      done: {
        issues: workDone,
        total: work,
        pct: pct(workDone, work),
        points: pointsDone,
        pointsTotal: points,
        pointsPct: pct(pointsDone, points),
      },
      open: num(a.open),
      overdue: counts.overdue,
      blocked: counts.blocked,
      highBugs: counts.highBugs,
      nextMilestone: next
        ? {
            id: next.id,
            name: next.name,
            date: next.release_date,
            daysLeft: daysBetween(today, next.release_date),
            overdue: next.release_date < today,
          }
        : null,
      overdueMilestones: overdueReleases.length,
      activeSprint: sprint
        ? {
            id: sprint.id,
            name: sprint.name,
            endDate: sprint.end_date || null,
            daysLeft: sprint.end_date ? daysBetween(today, sprint.end_date) : null,
          }
        : null,
      ...(guest ? {} : { budget: bud ? { kind: bud.kind, usedPct: bud.usedPct } : null }),
      lastActivity: a.last_activity || p.updated_at || p.created_at,
    };
  });

  // tiles and the Milestones strip
  const summary = { green: 0, amber: 0, red: 0, noReport: 0, overdue: 0, blocked: 0, milestonesSoon: 0 };
  const soon = dayStr(nowMs + SOON_DAYS * DAY);
  const horizon = dayStr(nowMs + MILESTONE_DAYS * DAY);
  const names = new Map(projects.map((p) => [p.id, p]));
  const milestones = [];
  for (const r of rows) {
    if (r.health.source === 'report' && summary[r.health.value] !== undefined) summary[r.health.value] += 1;
    else summary.noReport += 1;
    summary.overdue += r.overdue;
    summary.blocked += r.blocked;
  }
  for (const r of releases) {
    if (r.release_date < today || r.release_date > horizon) continue;
    if (r.release_date <= soon) summary.milestonesSoon += 1;
    const p = names.get(r.project_id);
    milestones.push({
      id: r.id,
      name: r.name,
      date: r.release_date,
      daysLeft: daysBetween(today, r.release_date),
      project: { key: p.key, name: p.name },
    });
  }
  return { today, rows, summary, milestones, budgetShown: !guest && rows.some((r) => r.budget) };
}
