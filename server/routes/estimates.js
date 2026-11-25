import { projectAccess } from '../lib/access.js';

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

/**
 * Estimates vs actuals per epic: estimated hours (sum of issue estimates), hours logged (work log),
 * remaining, variance, and story points done/total. Sub-tasks roll up to their parent's epic.
 * Two queries whatever the size.
 */
export async function estimatesReport(db, project) {
  const [issues, logs] = await Promise.all([
    db.all(
      `SELECT i.id, i.key, i.title, i.type, i.parent_id, i.estimate_hours, i.story_points, s.category
         FROM issues i JOIN statuses s ON s.id = i.status_id
        WHERE i.project_id = ? AND i.deleted_at IS NULL`,
      [project.id],
    ),
    db.all(
      `SELECT w.issue_id, SUM(w.hours) AS hours FROM worklogs w JOIN issues i ON i.id = w.issue_id
        WHERE i.project_id = ? AND i.deleted_at IS NULL GROUP BY w.issue_id`,
      [project.id],
    ),
  ]);
  const byId = new Map(issues.map((i) => [i.id, i]));
  const logged = new Map(logs.map((l) => [l.issue_id, Number(l.hours) || 0]));
  const epicOf = (i) => {
    if (i.type === 'epic') return i;
    let p = i.parent_id ? byId.get(i.parent_id) : null;
    if (p && p.type !== 'epic' && p.parent_id) p = byId.get(p.parent_id);
    return p && p.type === 'epic' ? p : null;
  };
  const groups = new Map();
  const row = (epic) => {
    const id = epic ? epic.id : 'none';
    if (!groups.has(id)) {
      groups.set(id, {
        key: epic?.key || null,
        title: epic ? epic.title : 'Issues without an epic',
        done: epic?.category === 'done',
        issues: 0,
        doneIssues: 0,
        estimate: 0,
        logged: 0,
        estimatedIssues: 0,
        points: 0,
        donePoints: 0,
      });
    }
    return groups.get(id);
  };
  for (const i of issues) {
    const g = row(epicOf(i));
    if (i.type !== 'epic') {
      g.issues++;
      if (i.category === 'done') g.doneIssues++;
      g.points += Number(i.story_points) || 0;
      if (i.category === 'done') g.donePoints += Number(i.story_points) || 0;
    }
    if (i.estimate_hours !== null && i.estimate_hours !== undefined) {
      g.estimate += Number(i.estimate_hours) || 0;
      g.estimatedIssues++;
    }
    g.logged += logged.get(i.id) || 0;
  }
  const rows = [...groups.values()].map((g) => ({
    ...g,
    estimate: r2(g.estimate),
    logged: r2(g.logged),
    remaining: r2(Math.max(0, g.estimate - g.logged)),
    variance: r2(g.logged - g.estimate),
    variancePct: g.estimate ? Math.round(((g.logged - g.estimate) / g.estimate) * 100) : null,
    points: r2(g.points),
    donePoints: r2(g.donePoints),
  }));
  rows.sort((a, b) => (a.key === null) - (b.key === null) || b.logged + b.estimate - (a.logged + a.estimate));
  const sum = (k) => r2(rows.reduce((s, x) => s + x[k], 0));
  const totals = {
    estimate: sum('estimate'),
    logged: sum('logged'),
    remaining: sum('remaining'),
    variance: r2(sum('logged') - sum('estimate')),
    issues: sum('issues'),
    doneIssues: sum('doneIssues'),
    points: sum('points'),
    donePoints: sum('donePoints'),
  };
  return { rows, totals };
}

export function registerEstimates(app) {
  app.get('/api/projects/:key/estimates', async (c) => {
    const { project } = await projectAccess(c, c.req.param('key'));
    return c.json(await estimatesReport(c.env.db, project));
  });
}
