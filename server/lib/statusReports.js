// Project status reports: the draft computed from tracker data, the RAG suggestion rules, and the output shapes.
// Routes: server/routes/statusReports.js. Table: status_reports (migration 0024).
//
// A draft covers a period of UTC days (default the last 7, ending today). It reads, in a handful of queries:
// the project's live issues (Trash left out), open 'blocks' links onto them, its sprints, releases with progress,
// work logs, and (only with an active sprint) the sprint burndown from server/routes/reports.js.
// Comments are never read, so internal notes cannot end up in a report.
//
// Budget: when the project has a budget (server/lib/budgets.js), the Budget RAG uses it: usage and the forecast at
// completion as percentages (no money, since members and shared guests read reports). Without one, "budget" is the
// hours estimate: the sum of issue estimates against all hours logged on the project. With neither there is no Budget RAG.
//
// Top risks: up to 5 active RAID risks with a score of 12 or more (server/lib/raid.js). The section starts as internal
// only, since guests never see the RAID log; a project admin can untick that before sharing.
import { projectReports } from './reports.js';
import { releaseProgress, listReleases, releaseOut } from './releases.js';
import { DAY } from './time.js';
import { budgetSnapshot, budgetRag } from './budgets.js';
import { topRisks, topRiskItem } from './raid.js';
import { parseJson } from './json.js';

export const RAG_VALUES = ['green', 'amber', 'red'];
export const RAG_DIMENSIONS = ['overall', 'scope', 'schedule', 'quality', 'budget'];
export const SECTION_KEYS = ['done', 'inProgress', 'next', 'milestones', 'risks', 'topRisks', 'decisions', 'time'];
export const SECTION_TITLES = {
  done: 'Done this period',
  inProgress: 'In progress',
  next: 'Planned next',
  milestones: 'Milestones and releases',
  risks: 'Risks and blockers',
  topRisks: 'Top risks',
  decisions: 'Decisions needed',
  time: 'Time logged this period',
};
const LIST_MAX = 60; // items per section
const HIGH = ['highest', 'high'];

/** Thresholds behind the suggestion (shown in Help and tested). */
export const RULES = {
  schedule: { overdueRed: 5, behindAmber: 0.1, behindRed: 0.25 },
  scope: { addedAmber: 0.2, addedRed: 0.5 },
  quality: { bugsAmber: 1, bugsRed: 3 },
  budget: { gapAmber: 0.1, gapRed: 0.25 },
};

const dayStr = (t) => new Date(t).toISOString().slice(0, 10);
const dayMs = (d) => Date.parse(`${d}T00:00:00.000Z`);
const r2 = (n) => Math.round(n * 100) / 100;
const worst = (list) => (list.includes('red') ? 'red' : list.includes('amber') ? 'amber' : 'green');

/** The report period: { start, end } (YYYY-MM-DD, end included). Default: the 7 days ending today. */
export function defaultPeriod(nowMs = Date.now(), days = 7) {
  return { start: dayStr(nowMs - (days - 1) * DAY), end: dayStr(nowMs) };
}

/** The issue as stored in a section list (no internal data: no comments, no hidden blockers). */
function item(i, extra = {}) {
  return {
    key: i.key,
    title: i.title,
    type: i.type,
    priority: i.priority,
    status: i.status_name,
    assignee: i.assignee_name || null,
    dueDate: i.due_date || null,
    epic: i.epic || null,
    ...extra,
  };
}

/**
 * Compute a draft: { data (numbers snapshot), sections (editable lists), rag (suggestions) }.
 * period: { start, end } YYYY-MM-DD.
 */
export async function computeDraft(db, project, period, nowMs = Date.now()) {
  const pid = project.id;
  const periodFrom = `${period.start}T00:00:00.000Z`;
  const periodTo = new Date(dayMs(period.end) + DAY - 1).toISOString();
  const today = dayStr(nowMs);
  const [issues, blockers, sprints, releases, progress, logs, raidRisks] = await Promise.all([
    db.all(
      `SELECT i.id, i.key, i.title, i.type, i.priority, i.parent_id, i.sprint_id, i.due_date, i.resolved_at, i.estimate_hours,
              s.name AS status_name, s.category, u.name AS assignee_name
         FROM issues i JOIN statuses s ON s.id = i.status_id LEFT JOIN users u ON u.id = i.assignee_id
        WHERE i.project_id = ? AND i.deleted_at IS NULL ORDER BY i.number`,
      [pid],
    ),
    db.all(
      `SELECT bl.target_id, bi.key, bi.project_id FROM issue_links bl JOIN issues bi ON bi.id = bl.source_id JOIN statuses bs ON bs.id = bi.status_id
         JOIN issues ti ON ti.id = bl.target_id
        WHERE bl.type = 'blocks' AND ti.project_id = ? AND ti.deleted_at IS NULL AND bi.deleted_at IS NULL AND bs.category <> 'done'`,
      [pid],
    ),
    db.all('SELECT id, name, state, start_date, end_date, created_at FROM sprints WHERE project_id = ? ORDER BY created_at', [pid]),
    listReleases(db, pid),
    releaseProgress(db, pid),
    db.all(
      `SELECT w.issue_id, w.user_id, u.name AS user_name, CAST(SUM(w.hours) AS DOUBLE PRECISION) AS total,
              CAST(SUM(CASE WHEN w.work_date >= ? AND w.work_date <= ? THEN w.hours ELSE 0 END) AS DOUBLE PRECISION) AS period
         FROM worklogs w JOIN issues i ON i.id = w.issue_id LEFT JOIN users u ON u.id = w.user_id
        WHERE i.project_id = ? AND i.deleted_at IS NULL GROUP BY w.issue_id, w.user_id, u.name`,
      [period.start, period.end, pid],
    ),
    topRisks(db, pid),
  ]);

  // epics: sub-tasks roll up through their parent (as the estimates report)
  const byId = new Map(issues.map((i) => [i.id, i]));
  for (const i of issues) {
    let p = i.parent_id ? byId.get(i.parent_id) : null;
    if (p && p.type !== 'epic' && p.parent_id) p = byId.get(p.parent_id);
    i.epic = p && p.type === 'epic' ? { key: p.key, title: p.title } : null;
  }
  const blockedBy = new Map();
  for (const b of blockers) {
    if (!blockedBy.has(b.target_id)) blockedBy.set(b.target_id, { keys: [], other: 0 });
    const m = blockedBy.get(b.target_id);
    if (b.project_id === pid) m.keys.push(b.key);
    else m.other += 1; // in another project: counted, never named (the client may not see it)
  }

  const work = issues.filter((i) => i.type !== 'epic' && i.type !== 'subtask');
  const open = issues.filter((i) => i.category !== 'done' && i.type !== 'epic');
  const done = work.filter((i) => i.category === 'done' && i.resolved_at && i.resolved_at >= periodFrom && i.resolved_at <= periodTo);
  const inProgress = work.filter((i) => i.category === 'in_progress');
  const overdue = open.filter((i) => i.due_date && i.due_date < today);
  const blocked = open.filter((i) => blockedBy.has(i.id));
  const highBugs = open.filter((i) => i.type === 'bug' && HIGH.includes(i.priority));
  const highOpen = open.filter((i) => HIGH.includes(i.priority));

  // planned next: the next future sprint, plus open to-do work due in the next period
  const active = sprints.find((s) => s.state === 'active') || null;
  const future = sprints
    .filter((s) => s.state === 'future')
    .sort((a, b) => (a.start_date || '9999').localeCompare(b.start_date || '9999') || a.created_at.localeCompare(b.created_at));
  const nextSprint = future[0] || null;
  const nextEnd = dayStr(dayMs(period.end) + 7 * DAY);
  const nextSet = new Map();
  if (nextSprint)
    for (const i of work) if (i.sprint_id === nextSprint.id && i.category !== 'done') nextSet.set(i.id, item(i, { why: nextSprint.name }));
  for (const i of work) {
    if (i.category === 'todo' && i.due_date && i.due_date > period.end && i.due_date <= nextEnd && !nextSet.has(i.id))
      nextSet.set(i.id, item(i, { why: `Due ${i.due_date}` }));
  }

  // milestones: unreleased releases and those released in the period
  const milestones = releases
    .filter(
      (r) =>
        r.status === 'unreleased' || (r.status === 'released' && (r.released_at || '') >= periodFrom && (r.released_at || '') <= periodTo),
    )
    .map((r) => {
      const o = releaseOut(r, progress.get(r.id), today);
      return {
        id: o.id,
        name: o.name,
        date: o.releaseDate,
        status: o.status,
        overdue: o.overdue,
        done: o.progress.done,
        total: o.progress.total,
      };
    });

  // risks: blocked, overdue, high priority open (one row per issue with every reason)
  const risks = new Map();
  const risk = (i, why) => {
    if (!risks.has(i.id)) risks.set(i.id, item(i, { reasons: [] }));
    risks.get(i.id).reasons.push(why);
  };
  for (const i of blocked) {
    const m = blockedBy.get(i.id);
    risk(
      i,
      `Blocked${m.keys.length ? ` by ${m.keys.join(', ')}` : ''}${m.other ? `${m.keys.length ? ' and' : ' by'} ${m.other} issue${m.other > 1 ? 's' : ''} in another project` : ''}`,
    );
  }
  for (const i of overdue) risk(i, `Overdue (due ${i.due_date})`);
  for (const i of highOpen) risk(i, `${i.priority === 'highest' ? 'Highest' : 'High'} priority${i.type === 'bug' ? ' bug' : ''}`);

  // time: hours logged in the period, by person; budget = all hours against the estimate
  let periodHours = 0;
  let totalHours = 0;
  const people = new Map();
  for (const l of logs) {
    const h = Number(l.period) || 0;
    periodHours += h;
    totalHours += Number(l.total) || 0;
    if (h > 0) people.set(l.user_name || 'Former user', (people.get(l.user_name || 'Former user') || 0) + h);
  }
  const time =
    periodHours > 0
      ? {
          total: r2(periodHours),
          byPerson: [...people]
            .map(([name, hours]) => ({ name, hours: r2(hours) }))
            .sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name)),
        }
      : null;
  const estimated = issues.filter((i) => i.estimate_hours !== null && i.estimate_hours !== undefined && Number(i.estimate_hours) > 0);
  const estimate = estimated.reduce((a, i) => a + Number(i.estimate_hours), 0);
  const estimateDone = estimated.filter((i) => i.category === 'done').reduce((a, i) => a + Number(i.estimate_hours), 0);
  const real = await budgetSnapshot(db, project, { nowMs, asOf: period.end < today ? period.end : today });
  const budget =
    real ||
    (estimate > 0
      ? { estimateHours: r2(estimate), loggedHours: r2(totalHours), burn: r2(totalHours / estimate), progress: r2(estimateDone / estimate) }
      : null);

  // sprint burndown (only with an active sprint: it reads the project history)
  let burndown = null;
  if (active) {
    const b = (await projectReports(db, project, { sprint: active.id, weeks: 1 }, nowMs)).burndown;
    if (b && !b.empty) {
      const usePoints = b.totals.committedPoints > 0;
      const last = [...b.days].reverse().find((d) => d.remainingPoints !== null);
      const committed = usePoints ? b.totals.committedPoints : b.totals.committedIssues;
      const remaining = last ? (usePoints ? last.remainingPoints : last.remainingIssues) : committed;
      const ideal = last ? (usePoints ? last.idealPoints : last.idealIssues) : committed;
      const added = usePoints ? b.totals.addedPoints : b.totals.addedIssues;
      burndown = {
        sprint: { id: active.id, name: active.name, startDate: active.start_date, endDate: active.end_date },
        unit: usePoints ? 'points' : 'issues',
        committed,
        remaining,
        ideal,
        added,
        behind: committed > 0 ? r2((remaining - ideal) / committed) : 0,
        scopeAdded: committed > 0 ? r2(added / committed) : 0,
      };
    }
  }

  const data = {
    period,
    generatedAt: new Date(nowMs).toISOString(),
    counts: {
      done: done.length,
      inProgress: inProgress.length,
      open: open.length,
      overdue: overdue.length,
      blocked: blocked.length,
      highBugs: highBugs.length,
      highOpen: highOpen.length,
      next: nextSet.size,
    },
    burndown,
    budget,
    time,
    nextSprint: nextSprint ? { id: nextSprint.id, name: nextSprint.name } : null,
    overdueReleases: milestones.filter((m) => m.overdue).map((m) => m.name),
  };
  const cap = (list) => list.slice(0, LIST_MAX);
  const sections = {
    done: {
      items: cap(
        done
          .sort((a, b) => (a.epic?.key || '~').localeCompare(b.epic?.key || '~') || a.resolved_at.localeCompare(b.resolved_at))
          .map((i) => item(i)),
      ),
      text: '',
      internal: false,
    },
    inProgress: { items: cap(inProgress.map((i) => item(i))), text: '', internal: false },
    next: { items: cap([...nextSet.values()]), text: '', internal: false },
    milestones: { items: milestones, text: '', internal: false },
    risks: { items: cap([...risks.values()]), text: '', internal: false },
    topRisks: { items: raidRisks.map(topRiskItem), text: '', internal: true },
    decisions: { items: [], text: '', internal: false },
    time: { items: time ? time.byPerson : [], total: time ? time.total : 0, text: '', internal: false, hidden: !time },
  };
  return { data, sections, rag: suggestRag(data) };
}

/** RAG suggestion from the snapshot: { overall, scope, schedule, quality, budget? } each { suggested, value, reason, why }. */
export function suggestRag(data) {
  const c = data.counts;
  const b = data.burndown;
  const dim = (value, why) => ({ suggested: value, value, reason: '', why });

  // schedule: overdue work, overdue releases, blocked work, sprint burndown against the ideal line
  const s = [];
  let sv = 'green';
  const up = (v) => {
    sv = worst([sv, v]);
  };
  if (c.overdue >= RULES.schedule.overdueRed) {
    up('red');
    s.push(`${c.overdue} issues are overdue`);
  } else if (c.overdue > 0) {
    up('amber');
    s.push(`${c.overdue} issue${c.overdue > 1 ? 's are' : ' is'} overdue`);
  }
  if (data.overdueReleases.length) {
    up('red');
    s.push(`Release past its date: ${data.overdueReleases.join(', ')}`);
  }
  if (c.blocked > 0) {
    up('amber');
    s.push(`${c.blocked} issue${c.blocked > 1 ? 's are' : ' is'} blocked`);
  }
  if (b) {
    const pct = Math.round(b.behind * 100);
    if (b.behind > RULES.schedule.behindRed) {
      up('red');
      s.push(`${b.sprint.name} is ${pct}% behind the ideal burndown`);
    } else if (b.behind > RULES.schedule.behindAmber) {
      up('amber');
      s.push(`${b.sprint.name} is ${pct}% behind the ideal burndown`);
    }
  }
  if (!s.length) s.push(b ? `No overdue or blocked work and ${b.sprint.name} is on track` : 'No overdue or blocked work');

  // scope: work added to the active sprint after it started
  let scope;
  if (!b) scope = dim('green', ['No active sprint, so no scope change to measure']);
  else {
    const pct = Math.round(b.scopeAdded * 100);
    const v = b.scopeAdded > RULES.scope.addedRed ? 'red' : b.scopeAdded > RULES.scope.addedAmber ? 'amber' : 'green';
    scope = dim(v, [
      b.added > 0
        ? `${b.added} ${b.unit} added to ${b.sprint.name} after it started (${pct}% of the commitment)`
        : `No ${b.unit} added to ${b.sprint.name} after it started`,
    ]);
  }

  // quality: open high or highest priority bugs
  const qv = c.highBugs >= RULES.quality.bugsRed ? 'red' : c.highBugs >= RULES.quality.bugsAmber ? 'amber' : 'green';
  const quality = dim(qv, [c.highBugs ? `${c.highBugs} open high priority bug${c.highBugs > 1 ? 's' : ''}` : 'No open high priority bugs']);

  const out = { overall: null, scope, schedule: dim(sv, s), quality };
  // budget: hours logged against the estimate, compared with the share of estimated work that is done
  if (data.budget?.source === 'budget') {
    const r = budgetRag(data.budget);
    out.budget = dim(r.value, r.why);
  } else if (data.budget) {
    const g = data.budget.burn - data.budget.progress;
    const v = data.budget.burn > 1 || g > RULES.budget.gapRed ? 'red' : g > RULES.budget.gapAmber ? 'amber' : 'green';
    out.budget = dim(v, [
      `${data.budget.loggedHours} of ${data.budget.estimateHours} estimated hours used (${Math.round(data.budget.burn * 100)}%), ${Math.round(data.budget.progress * 100)}% of the estimated work done`,
    ]);
  }
  const parts = Object.entries(out).filter(([k, x]) => k !== 'overall' && x);
  const ov = worst(parts.map(([, x]) => x.value));
  out.overall = dim(
    ov,
    ov === 'green'
      ? ['Every area is Green']
      : parts.filter(([, x]) => x.value === ov).map(([k]) => `${k[0].toUpperCase()}${k.slice(1)} is ${ov === 'red' ? 'Red' : 'Amber'}`),
  );
  if (!out.budget) delete out.budget;
  return out;
}

/**
 * A status_reports row for the API. forGuest: no data snapshot and no sections marked internal.
 * Rows may carry author_name.
 */
export function reportOut(r, { forGuest = false } = {}) {
  const sections = parseJson(r.sections, {});
  if (forGuest) for (const k of Object.keys(sections)) if (sections[k]?.internal) delete sections[k];
  return {
    id: r.id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    rag: parseJson(r.rag, {}),
    summary: r.summary || '',
    sections,
    ...(forGuest ? {} : { data: parseJson(r.data, {}) }),
    status: r.status,
    publishedAt: r.published_at || null,
    sharedWithGuests: Boolean(Number(r.shared_with_guests)),
    author: r.author_id ? { id: r.author_id, name: r.author_name || 'Former user' } : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** List rows: no sections or data. */
export function reportBrief(r) {
  const rag = parseJson(r.rag, {});
  return {
    id: r.id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    rag: Object.fromEntries(Object.entries(rag).map(([k, v]) => [k, v?.value || null])),
    status: r.status,
    publishedAt: r.published_at || null,
    sharedWithGuests: Boolean(Number(r.shared_with_guests)),
    author: r.author_id ? { id: r.author_id, name: r.author_name || 'Former user' } : null,
    updatedAt: r.updated_at,
  };
}

/** The prompt for "Draft with AI": numbers and issue titles only, never comments. */
export function aiSummaryPrompt(project, report) {
  const s = report.sections || {};
  const list = (k) =>
    (s[k]?.items || [])
      .slice(0, 25)
      .map((i) => `- ${i.key ? `${i.key} ` : ''}${i.title || i.name || i.text || ''}${i.reasons ? ` (${i.reasons.join('; ')})` : ''}`)
      .join('\n') || '- none';
  const rag = Object.entries(report.rag || {})
    .map(([k, v]) => `${k}: ${v.value}${v.reason ? ` (${v.reason})` : ''}; ${(v.why || []).join('; ')}`)
    .join('\n');
  return [
    `Project: ${project.name} (${project.key}). Period: ${report.periodStart} to ${report.periodEnd}.`,
    `RAG:\n${rag}`,
    `Done this period:\n${list('done')}`,
    `In progress:\n${list('inProgress')}`,
    `Planned next:\n${list('next')}`,
    `Milestones:\n${(s.milestones?.items || []).map((m) => `- ${m.name}: ${m.status}${m.date ? `, ${m.date}` : ''}, ${m.done} of ${m.total} done${m.overdue ? ', past its date' : ''}`).join('\n') || '- none'}`,
    `Risks and blockers:\n${list('risks')}${s.risks?.text ? `\n${s.risks.text}` : ''}`,
    ...(s.topRisks?.items?.length && !s.topRisks.internal ? [`Top risks from the RAID log:\n${list('topRisks')}`] : []),
  ].join('\n\n');
}

export const AI_SUMMARY_SYSTEM =
  'You write the summary paragraph of a weekly project status report that a consulting firm sends to its client. ' +
  'Use plain, direct, professional English in 3 to 5 sentences: what was achieved, what is in progress, the main risk and what happens next. ' +
  'Use only the facts given. No headings, no lists, no em dashes, no marketing words. Refer to issues by title, not key.';
