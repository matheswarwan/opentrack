// Portfolio: per-project numbers, health (published report vs computed), visibility and guests, budget adapter,
// browser helpers (filters, sort, CSV, URL query) and a flat statement count as projects grow.
import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser } from './helpers.js';
import { budgetSummaries } from '../server/lib/portfolio.js';
import { filterRows, sortRows, toCsv, filtersFromQuery, queryFromFilters, leadsOf, healthText, DEFAULT_FILTERS } from '../src/portfolio.js';

const DAY = 864e5;
const dateIn = (n) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
let ctx, bob, carol, gina;

async function issue(c, key, fields = {}) {
  const r = await c.post('/api/issues', { projectKey: key, title: fields.title || 'Work', ...fields });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.issue;
}
async function statusesOf(c, key) {
  return (await c.get(`/api/projects/${key}`)).body.project.statuses;
}
const row = (body, key) => body.rows.find((r) => r.key === key);

// WEB (open, Bob leads): the numbers. CLI (private, Bob, Gina is a guest member): health from a report.
// SEC (private, Carol only): hidden from Bob. OLD: archived.
beforeEach(async () => {
  ctx = await withAdmin();
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
  gina = await addUser(ctx, { email: 'gina@client.example', name: 'Gina Guest', role: 'guest' });
  const b = bob.client;
  await b.post('/api/projects', { key: 'WEB', name: 'Website' });
  await b.post('/api/projects', { key: 'CLI', name: 'Client portal', visibility: 'private' });
  await b.put(`/api/projects/CLI/members/${gina.id}`, { role: 'guest-view' });
  await carol.client.post('/api/projects', { key: 'SEC', name: 'Secret', visibility: 'private' });
  await b.post('/api/projects', { key: 'OLD', name: 'Old project' });
  await ctx.admin.patch('/api/projects/OLD', { archived: true });

  const st = await statusesOf(b, 'WEB');
  const done = st.find((s) => s.category === 'done').id;
  await issue(b, 'WEB', { type: 'epic', title: 'Epic' }); // WEB-1: not counted
  await issue(b, 'WEB', { title: 'Done A', storyPoints: 3 }); // WEB-2 done
  await issue(b, 'WEB', { title: 'Open B', storyPoints: 5, dueDate: dateIn(-2) }); // WEB-3 overdue
  await issue(b, 'WEB', { type: 'bug', title: 'Crash', priority: 'high' }); // WEB-4 high bug
  await issue(b, 'WEB', { type: 'bug', title: 'Typo', priority: 'low' }); // WEB-5 low bug
  await issue(b, 'WEB', { title: 'Blocked C' }); // WEB-6 blocked by WEB-3
  await issue(b, 'WEB', { title: 'Trashed', dueDate: dateIn(-9), storyPoints: 8 }); // WEB-7 in the Trash
  await b.patch('/api/issues/WEB-2', { statusId: done });
  await b.post('/api/issues/WEB-3/links', { type: 'blocks', targetKey: 'WEB-6' });
  await b.post('/api/issues/WEB-7/links', { type: 'blocks', targetKey: 'WEB-5' }); // blocker in the Trash: not blocked
  await b.del('/api/issues/WEB-7');
  await b.post('/api/projects/WEB/releases', { name: 'Late', releaseDate: dateIn(-1) });
  await b.post('/api/projects/WEB/releases', { name: 'Beta', releaseDate: dateIn(10) });
  await b.post('/api/projects/WEB/releases', { name: 'GA', releaseDate: dateIn(60) });
  await b.post('/api/projects/WEB/releases', { name: 'Far', releaseDate: dateIn(200) });
  const sprint = (await b.post('/api/projects/WEB/sprints', { name: 'Sprint 1', startDate: dateIn(-3), endDate: dateIn(4) })).body.sprint;
  await b.post(`/api/sprints/${sprint.id}/start`, { startDate: dateIn(-3), endDate: dateIn(4) });

  await issue(b, 'CLI', { title: 'Client work' });
});

describe('GET /api/portfolio', () => {
  it('computes the numbers per project, leaving out epics and the Trash', async () => {
    const r = await bob.client.get('/api/portfolio');
    expect(r.status).toBe(200);
    const w = row(r.body, 'WEB');
    expect(w.done).toEqual({ issues: 1, total: 5, pct: 20, points: 3, pointsTotal: 8, pointsPct: 38 });
    expect(w.open).toBe(4);
    expect(w.overdue).toBe(1);
    expect(w.blocked).toBe(1);
    expect(w.highBugs).toBe(1);
    expect(w.nextMilestone).toMatchObject({ name: 'Late', overdue: true, daysLeft: -1 });
    expect(w.overdueMilestones).toBe(1);
    expect(w.activeSprint).toMatchObject({ name: 'Sprint 1' });
    expect(typeof w.lastActivity).toBe('string');
    expect(w.lead).toMatchObject({ name: 'Bob' });
    expect(w.mine).toBe(true);
    // milestones strip: next 90 days only, overdue and far ones left out
    expect(r.body.milestones.map((m) => m.name)).toEqual(['Beta', 'GA']);
    expect(r.body.summary.milestonesSoon).toBe(1);
    expect(r.body.summary.overdue).toBe(1);
    expect(r.body.summary.blocked).toBe(1);
  });

  it('uses the latest published report, else a computed health', async () => {
    let w = row((await bob.client.get('/api/portfolio')).body, 'WEB');
    expect(w.health.source).toBe('computed');
    expect(w.health.value).toBe('red'); // a release past its date
    expect(w.health.why.join(' ')).toMatch(/Schedule is Red/);
    let cli = row((await bob.client.get('/api/portfolio')).body, 'CLI');
    expect(cli.health).toMatchObject({ source: 'computed', value: 'green' });

    // a draft does not count; a published one does
    const rep = (await bob.client.post('/api/projects/CLI/status-reports', {})).body.report;
    expect(row((await bob.client.get('/api/portfolio')).body, 'CLI').health.source).toBe('computed');
    await bob.client.patch(`/api/projects/CLI/status-reports/${rep.id}`, {
      rag: { overall: { value: 'amber', reason: 'Client is slow to reply' } },
    });
    await bob.client.post(`/api/projects/CLI/status-reports/${rep.id}/publish`);
    const body = (await bob.client.get('/api/portfolio')).body;
    cli = row(body, 'CLI');
    expect(cli.health).toMatchObject({ source: 'report', value: 'amber', reportId: rep.id });
    expect(body.summary).toMatchObject({ amber: 1, noReport: 1, green: 0, red: 0 });
    // the computed health can be Green while WEB stays computed
    w = row(body, 'WEB');
    expect(w.health.source).toBe('computed');
  });

  it('shows only visible projects and hides archived ones unless asked', async () => {
    const keys = (await bob.client.get('/api/portfolio')).body.rows.map((r) => r.key);
    expect(keys).toEqual(['CLI', 'WEB']);
    const all = (await bob.client.get('/api/portfolio?archived=1')).body.rows.map((r) => r.key);
    expect(all).toEqual(['CLI', 'OLD', 'WEB']);
    const admin = (await ctx.admin.get('/api/portfolio')).body.rows.map((r) => r.key);
    expect(admin).toEqual(['CLI', 'SEC', 'WEB']);
    const carolKeys = (await carol.client.get('/api/portfolio')).body.rows.map((r) => r.key);
    expect(carolKeys).toEqual(['SEC', 'WEB']);
    expect(row((await carol.client.get('/api/portfolio')).body, 'WEB').mine).toBe(false);
  });

  it('gives guests their member projects only, no budget, and shared reports only', async () => {
    let r = await gina.client.get('/api/portfolio');
    expect(r.status).toBe(200);
    expect(r.body.rows.map((x) => x.key)).toEqual(['CLI']);
    expect(r.body.budgetShown).toBe(false);
    expect('budget' in r.body.rows[0]).toBe(false);
    // published but not shared: the guest sees a computed health
    const rep = (await bob.client.post('/api/projects/CLI/status-reports', {})).body.report;
    await bob.client.post(`/api/projects/CLI/status-reports/${rep.id}/publish`);
    r = await gina.client.get('/api/portfolio');
    expect(r.body.rows[0].health.source).toBe('computed');
    await bob.client.post(`/api/projects/CLI/status-reports/${rep.id}/unpublish`);
    await bob.client.patch(`/api/projects/CLI/status-reports/${rep.id}`, { sharedWithGuests: true });
    await bob.client.post(`/api/projects/CLI/status-reports/${rep.id}/publish`);
    r = await gina.client.get('/api/portfolio');
    expect(r.body.rows[0].health).toMatchObject({ source: 'report', reportId: rep.id });
  });

  it('shows budget % used for hours and money budgets, never to guests', async () => {
    expect(row((await bob.client.get('/api/portfolio')).body, 'WEB').budget).toBeNull();
    expect((await bob.client.get('/api/portfolio')).body.budgetShown).toBe(false);
    // hours budget of 10 with 4 billable hours (2 non-billable)
    expect((await bob.client.put('/api/projects/WEB/budget', { kind: 'hours', amount: 10 })).status).toBe(200);
    await bob.client.post('/api/issues/WEB-3/worklogs', { hours: 4 });
    await bob.client.post('/api/issues/WEB-4/worklogs', { hours: 2, billable: false });
    let body = (await bob.client.get('/api/portfolio')).body;
    expect(row(body, 'WEB').budget).toEqual({ kind: 'hours', usedPct: 40 });
    expect(row(body, 'CLI').budget).toBeNull();
    expect(body.budgetShown).toBe(true);
    expect('budget' in (await gina.client.get('/api/portfolio')).body.rows[0]).toBe(false);
    // money budget of 1000 at a default rate of 50: 4 billable hours = 200 = 20%
    expect((await bob.client.put('/api/projects/WEB/budget', { kind: 'money', amount: 1000 })).status).toBe(200);
    expect(
      (await bob.client.post('/api/projects/WEB/budget/rates', { scope: 'default', rate: 50, effectiveFrom: '2020-01-01' })).status,
    ).toBe(201);
    body = (await bob.client.get('/api/portfolio')).body;
    expect(row(body, 'WEB').budget).toEqual({ kind: 'money', usedPct: 20 });
    const ids = body.rows.map((r) => r.id);
    expect(Object.values(await budgetSummaries(ctx.db, ids))[0]).toMatchObject({ kind: 'money', used: 200, usedPct: 20 });
  });

  it('uses the same number of statements for 3 and 12 projects', async () => {
    const counts = {};
    for (const n of [3, 12]) {
      const c2 = await withAdmin();
      const dan = await addUser(c2, { email: 'dan@example.com', name: 'Dan' });
      for (let i = 0; i < n; i++) {
        const key = `P${i}X`;
        await dan.client.post('/api/projects', { key, name: `Project ${i}`, visibility: i % 2 ? 'private' : 'open' });
        await issue(dan.client, key, { dueDate: dateIn(-1) });
        await issue(dan.client, key, { type: 'bug', priority: 'highest' });
        await dan.client.post(`/api/issues/${key}-1/links`, { type: 'blocks', targetKey: `${key}-2` });
        await dan.client.post(`/api/projects/${key}/releases`, { name: 'R', releaseDate: dateIn(5) });
        await dan.client.post(`/api/issues/${key}-1/worklogs`, { hours: 1 });
        const s = (await dan.client.post(`/api/projects/${key}/sprints`, {})).body.sprint;
        await dan.client.post(`/api/sprints/${s.id}/start`, {});
        if (i % 3 === 0) {
          const rep = (await dan.client.post(`/api/projects/${key}/status-reports`, {})).body.report;
          await dan.client.post(`/api/projects/${key}/status-reports/${rep.id}/publish`);
        }
      }
      let k = 0;
      const db = c2.env.db;
      const wrap =
        (fn) =>
        async (...a) => {
          k++;
          return fn(...a);
        };
      c2.env.db = {
        ...db,
        all: wrap(db.all.bind(db)),
        get: wrap(db.get.bind(db)),
        run: wrap(db.run.bind(db)),
        batch: async (s) => {
          k += s.length;
          return db.batch(s);
        },
      };
      const r = await dan.client.get('/api/portfolio');
      expect(r.status).toBe(200);
      expect(r.body.rows).toHaveLength(n);
      counts[n] = k;
      c2.env.db = db;
    }
    console.log('portfolio statements (3 vs 12 projects):', JSON.stringify(counts));
    expect(counts[12]).toBe(counts[3]);
    expect(counts[12]).toBeLessThan(12);
  });
});

describe('browser helpers', () => {
  const rows = [
    {
      id: '1',
      key: 'WEB',
      name: 'Website',
      lead: { id: 'u1', name: 'Bob' },
      mine: true,
      archived: false,
      health: { source: 'report', value: 'red', periodEnd: '2026-11-15' },
      done: { pct: 20, issues: 1, total: 5, points: 3, pointsTotal: 8, pointsPct: 38 },
      open: 4,
      overdue: 1,
      blocked: 1,
      highBugs: 1,
      nextMilestone: { name: '=cmd', date: '2026-11-20', daysLeft: -2 },
      activeSprint: null,
      budget: { usedPct: 40 },
      lastActivity: '2026-11-18T10:00:00Z',
    },
    {
      id: '2',
      key: 'CLI',
      name: 'Client, portal',
      lead: { id: 'u2', name: 'Ann' },
      mine: false,
      archived: false,
      health: { source: 'computed', value: 'green' },
      done: { pct: null, issues: 0, total: 0, points: 0, pointsTotal: 0, pointsPct: null },
      open: 0,
      overdue: 0,
      blocked: 0,
      highBugs: 0,
      nextMilestone: null,
      activeSprint: { name: 'S1', daysLeft: 3 },
      budget: null,
      lastActivity: '2026-11-10T10:00:00Z',
    },
    {
      id: '3',
      key: 'APP',
      name: 'App',
      lead: null,
      mine: true,
      archived: true,
      health: { source: 'report', value: 'green', periodEnd: '2026-11-01' },
      done: { pct: 90, issues: 9, total: 10, points: 0, pointsTotal: 0, pointsPct: null },
      open: 1,
      overdue: 3,
      blocked: 0,
      highBugs: 0,
      nextMilestone: { name: 'v2', date: '2026-12-01', daysLeft: 12 },
      activeSprint: null,
      budget: null,
      lastActivity: '2026-11-17T10:00:00Z',
    },
  ];
  it('filters by search, lead, health, My projects', () => {
    const f = (x) => filterRows(rows, { ...DEFAULT_FILTERS, ...x }).map((r) => r.key);
    expect(f({ q: 'port' })).toEqual(['CLI']);
    expect(f({ q: 'app' })).toEqual(['APP']);
    expect(f({ lead: 'u1' })).toEqual(['WEB']);
    expect(f({ lead: 'none' })).toEqual(['APP']);
    expect(f({ health: 'green' })).toEqual(['APP']); // computed Green is not a report
    expect(f({ health: 'none' })).toEqual(['CLI']);
    expect(f({ mine: true })).toEqual(['WEB', 'APP']);
  });
  it('sorts any column with empty values last', () => {
    expect(sortRows(rows, 'done', 'asc').map((r) => r.key)).toEqual(['WEB', 'APP', 'CLI']);
    expect(sortRows(rows, 'done', 'desc').map((r) => r.key)).toEqual(['APP', 'WEB', 'CLI']);
    expect(sortRows(rows, 'health', 'desc').map((r) => r.key)).toEqual(['WEB', 'CLI', 'APP']);
    expect(sortRows(rows, 'milestone', 'asc').map((r) => r.key)).toEqual(['WEB', 'APP', 'CLI']);
    expect(sortRows(rows, 'overdue', 'desc').map((r) => r.key)).toEqual(['APP', 'WEB', 'CLI']);
    expect(sortRows(rows, 'name', 'asc').map((r) => r.key)).toEqual(['APP', 'CLI', 'WEB']);
    expect(leadsOf(rows)).toEqual([
      { id: 'u2', name: 'Ann' },
      { id: 'u1', name: 'Bob' },
    ]);
  });
  it('round-trips filters through the URL query', () => {
    const f = { ...DEFAULT_FILTERS, q: 'web', lead: 'u1', health: 'red', mine: true, archived: true, sort: 'overdue', dir: 'asc' };
    const q = queryFromFilters(f);
    expect(q).toEqual({ q: 'web', lead: 'u1', health: 'red', mine: '1', archived: '1', sort: 'overdue', dir: 'asc' });
    expect(filtersFromQuery(q)).toEqual(f);
    expect(queryFromFilters(DEFAULT_FILTERS)).toEqual({});
    expect(filtersFromQuery({ sort: 'nope', health: 'purple', dir: 'x' })).toEqual(DEFAULT_FILTERS);
  });
  it('exports CSV with quoting, formula guard and the budget column only when shown', () => {
    const csv = toCsv(rows, { budgetShown: true }).split('\n');
    expect(csv).toHaveLength(4);
    expect(csv[0]).toContain('Budget used %');
    expect(csv[1]).toContain(',40,');
    expect(csv[1]).toContain("'=cmd");
    expect(csv[1]).toContain(',-2,');
    expect(csv[2].startsWith('CLI,"Client, portal",Ann,Green,computed,')).toBe(true);
    expect(toCsv(rows).split('\n')[0]).not.toContain('Budget');
    expect(healthText(rows[0].health)).toBe('Red, status report to 2026-11-15');
    expect(healthText(rows[1].health)).toBe('No report, computed Green');
  });
});
