import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser } from './helpers.js';

const DAY = 864e5;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
const dateIn = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

let ctx, bob, carol, dave, web, k;

/**
 * WEB (open, Bob's): EP epic to do; W1 story high Carol 3 pts 4 h, labels ui+api, under EP, created
 * 10 days ago, 1.5 h logged; W2 bug highest Carol 5 pts in progress, due yesterday, created 5 days
 * ago; W3 task low Bob 2 pts 1 h done, due in 3 days, created 3 days ago, resolved 1 day ago;
 * W4 task medium unassigned to do. SEC (private, Dave only): S1 bug Dave 8 pts, created 2 days ago.
 */
beforeEach(async () => {
  ctx = await withAdmin();
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
  dave = await addUser(ctx, { email: 'dave@example.com', name: 'Dave' });
  web = (await bob.client.post('/api/projects', { key: 'WEB', name: 'Website' })).body.project;
  await dave.client.post('/api/projects', { key: 'SEC', name: 'Security', visibility: 'private' });
  const byName = Object.fromEntries(web.statuses.map((s) => [s.name, s.id]));
  const st = { in_progress: byName['In Progress'], done: byName.Done };
  const make = async (who, data) => {
    const r = await who.client.post('/api/issues', data);
    expect(r.status).toBe(201);
    return r.body.issue.key;
  };
  k = {};
  k.EP = await make(bob, { projectKey: 'WEB', title: 'Epic', type: 'epic' });
  k.W1 = await make(bob, {
    projectKey: 'WEB',
    title: 'One',
    type: 'story',
    priority: 'high',
    assigneeId: carol.id,
    storyPoints: 3,
    estimateHours: 4,
    labels: ['ui', 'api'],
    parentKey: k.EP,
  });
  k.W2 = await make(bob, {
    projectKey: 'WEB',
    title: 'Two',
    type: 'bug',
    priority: 'highest',
    assigneeId: carol.id,
    storyPoints: 5,
    statusId: st.in_progress,
    dueDate: dateIn(-1),
    labels: ['ui'],
  });
  k.W3 = await make(bob, {
    projectKey: 'WEB',
    title: 'Three',
    type: 'task',
    priority: 'low',
    assigneeId: bob.id,
    storyPoints: 2,
    estimateHours: 1,
    statusId: st.done,
    dueDate: dateIn(3),
  });
  k.W4 = await make(bob, { projectKey: 'WEB', title: 'Four', type: 'task' });
  k.S1 = await make(dave, { projectKey: 'SEC', title: 'Secret', type: 'bug', assigneeId: dave.id, storyPoints: 8 });
  expect((await carol.client.post(`/api/issues/${k.W1}/worklogs`, { hours: 1.5 })).status).toBe(201);
  const db = ctx.db;
  await db.run('UPDATE issues SET created_at = ? WHERE key = ?', [ago(10), k.W1]);
  await db.run('UPDATE issues SET created_at = ? WHERE key = ?', [ago(5), k.W2]);
  await db.run('UPDATE issues SET created_at = ?, resolved_at = ? WHERE key = ?', [ago(3), ago(1), k.W3]);
  await db.run('UPDATE issues SET created_at = ? WHERE key = ?', [ago(2), k.S1]);
});

const data = (who, def) => who.client.post('/api/report-data', def);
const groups = (r) => Object.fromEntries(r.body.groups.map((g) => [g.label, g.value]));

describe('report data', () => {
  it('breakdown counts and sums by field', async () => {
    const byStatus = await data(bob, { source: { query: {} }, kind: 'breakdown', options: { groupBy: 'status' } });
    expect(byStatus.status).toBe(200);
    expect(groups(byStatus)).toEqual({ 'To Do': 2 + 1, 'In Progress': 1, Done: 1 });
    expect(byStatus.body).toMatchObject({ total: 5, issues: 5, metric: 'count', chart: 'pie' });
    expect(byStatus.body.groups.find((g) => g.label === 'Done').filter).toEqual({ statusName: 'Done' });

    const pts = await data(bob, {
      source: { query: { project: 'WEB' } },
      kind: 'breakdown',
      options: { groupBy: 'assignee', metric: 'storyPoints' },
    });
    expect(groups(pts)).toEqual({ Carol: 8, Bob: 2, Unassigned: 0 });
    expect(pts.body.groups.find((g) => g.label === 'Unassigned').filter).toEqual({ assignee: 'unassigned' });

    const logged = await data(bob, { source: { query: {} }, kind: 'breakdown', options: { groupBy: 'assignee', metric: 'loggedHours' } });
    expect(groups(logged).Carol).toBe(1.5);
    const est = await data(bob, {
      source: { query: {} },
      kind: 'breakdown',
      options: { groupBy: 'type', metric: 'estimateHours', chart: 'bar' },
    });
    expect(est.body.groups.map((g) => [g.key, g.value])).toEqual([
      ['epic', 0],
      ['story', 4],
      ['task', 1],
      ['bug', 0],
    ]); // natural type order

    const labels = await data(bob, { source: { query: {} }, kind: 'breakdown', options: { groupBy: 'label' } });
    expect(groups(labels)).toEqual({ ui: 2, api: 1, 'No label': 3 });
    expect(labels.body.issues).toBe(5);

    const epic = await data(bob, { source: { query: {} }, kind: 'breakdown', options: { groupBy: 'epic' } });
    expect(groups(epic)).toEqual({ [`${k.EP} Epic`]: 1, 'No epic': 4 });
    const due = await data(bob, { source: { query: {} }, kind: 'breakdown', options: { groupBy: 'dueBucket' } });
    expect(due.body.groups.map((g) => [g.key, g.value])).toEqual([
      ['overdue', 1],
      ['week', 1],
      ['none', 3],
    ]);
    expect(due.body.groups[0].filter).toEqual({ dueBefore: dateIn(-1) });
    const pri = await data(bob, { source: { query: {} }, kind: 'breakdown', options: { groupBy: 'priority' } });
    expect(pri.body.groups.map((g) => g.key)).toEqual(['highest', 'high', 'medium', 'low']);
  });

  it('two-dimensional statistics', async () => {
    const r = await data(bob, { source: { query: {} }, kind: 'twoD', options: { rows: 'assignee', columns: 'statusCategory' } });
    expect(r.status).toBe(200);
    expect(r.body.columns.map((c) => c.key)).toEqual(['todo', 'in_progress', 'done']);
    const cell = (row, col) => r.body.cells[r.body.rows.findIndex((x) => x.label === row)][r.body.columns.findIndex((x) => x.key === col)];
    expect(cell('Carol', 'todo')).toBe(1);
    expect(cell('Carol', 'in_progress')).toBe(1);
    expect(cell('Bob', 'done')).toBe(1);
    expect(cell('Unassigned', 'todo')).toBe(2);
    expect(r.body.total).toBe(5);
    const pts = await data(bob, {
      source: { query: {} },
      kind: 'twoD',
      options: { rows: 'type', columns: 'assignee', metric: 'storyPoints' },
    });
    expect(pts.body.total).toBe(10);
  });

  it('created vs resolved, cumulative and by week', async () => {
    const r = await data(bob, { source: { query: {} }, kind: 'createdVsResolved', options: { period: 'day', days: 14 } });
    expect(r.status).toBe(200);
    expect(r.body.periods).toHaveLength(14);
    expect(r.body.totals).toEqual({ created: 5, resolved: 1 });
    expect(r.body.created[r.body.periods.indexOf(ago(10).slice(0, 10))]).toBe(1);
    expect(r.body.resolved[r.body.periods.indexOf(ago(1).slice(0, 10))]).toBe(1);
    expect(r.body.created.at(-1)).toBe(2); // EP and W4, today
    const cum = await data(bob, {
      source: { query: {} },
      kind: 'createdVsResolved',
      options: { period: 'day', days: 14, cumulative: true },
    });
    expect(cum.body.created.at(-1)).toBe(5);
    expect(cum.body.resolved.at(-1)).toBe(1);
    const week = await data(bob, { source: { query: {} }, kind: 'createdVsResolved', options: { period: 'month', days: 60 } });
    expect(week.body.totals).toEqual({ created: 5, resolved: 1 });
    // only the window counts: W1 (10 days ago) is outside a 7 day range
    const short = await data(bob, { source: { query: {} }, kind: 'createdVsResolved', options: { period: 'day', days: 7 } });
    expect(short.body.totals.created).toBe(4);
  });

  it('average age of unresolved issues', async () => {
    const r = await data(bob, { source: { query: {} }, kind: 'averageAge', options: { period: 'day', days: 3 } });
    expect(r.status).toBe(200);
    expect(r.body.points).toHaveLength(3);
    const last = r.body.points.at(-1);
    expect(last.open).toBe(4); // EP, W1, W2, W4 (W3 resolved yesterday)
    expect(last.averageDays).toBeGreaterThan(3.6);
    expect(last.averageDays).toBeLessThan(3.9); // (10 + 5 + 0 + 0) / 4
    // at the end of the first day W1, W2 and W3 were open (EP and W4 did not exist yet)
    expect(r.body.points[0].open).toBe(3);
  });

  it('workload per assignee', async () => {
    const r = await data(bob, { source: { query: {} }, kind: 'workload' });
    expect(r.status).toBe(200);
    expect(r.body.people).toEqual([
      {
        id: carol.id,
        name: 'Carol',
        issues: 2,
        points: 8,
        estimateHours: 4,
        loggedHours: 1.5,
        filter: { assignee: carol.id, category: 'todo,in_progress' },
      },
      {
        id: null,
        name: 'Unassigned',
        issues: 2,
        points: 0,
        estimateHours: 0,
        loggedHours: 0,
        filter: { assignee: 'unassigned', category: 'todo,in_progress' },
      },
    ]);
    const all = await data(bob, { source: { query: {} }, kind: 'workload', options: { includeDone: true } });
    expect(all.body.people.find((p) => p.name === 'Bob')).toMatchObject({ issues: 1, points: 2 });
    expect(all.body.totals.issues).toBe(5);
  });

  it('lists issues with relative due dates', async () => {
    const r = await data(bob, {
      source: { query: {} },
      kind: 'list',
      options: { sort: 'created', dir: 'desc', limit: 2, columns: ['key', 'title'] },
    });
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(5);
    expect(r.body.issues).toHaveLength(2);
    expect(r.body.columns).toEqual(['key', 'title']);
    const due = await data(bob, {
      source: { query: { category: 'todo,in_progress', dueWithinDays: 14 } },
      kind: 'list',
      options: { sort: 'due', dir: 'asc' },
    });
    expect(due.body.issues.map((i) => i.key)).toEqual([k.W2]);
    expect(due.body.query).toEqual({ category: 'todo,in_progress', dueBefore: dateIn(14) });
  });

  it('runs from a saved filter, as the viewer', async () => {
    const f = await bob.client.post('/api/filters', { name: 'Carol work', query: { project: 'WEB', assignee: carol.id, sort: 'updated' } });
    const r = await data(bob, { source: { filterId: f.body.id }, kind: 'breakdown', options: { groupBy: 'type' } });
    expect(groups(r)).toEqual({ Story: 1, Bug: 1 });
    expect(r.body.query).toEqual({ project: 'WEB', assignee: carol.id });
    // someone else's private filter is not usable
    expect((await data(carol, { source: { filterId: f.body.id }, kind: 'breakdown', options: { groupBy: 'type' } })).status).toBe(404);
    // a shared "assigned to me" filter counts the viewer's issues
    const me = await bob.client.post('/api/filters', { name: 'Mine', query: { assignee: 'me' }, shared: true });
    const asCarol = await data(carol, { source: { filterId: me.body.id }, kind: 'breakdown', options: { groupBy: 'assignee' } });
    expect(groups(asCarol)).toEqual({ Carol: 2 });
  });

  it('never counts private project issues for non-members', async () => {
    const def = { source: { query: {} }, kind: 'breakdown', options: { groupBy: 'project' } };
    expect(groups(await data(bob, def))).toEqual({ 'Website (WEB)': 5 });
    expect(groups(await data(dave, def))).toEqual({ 'Website (WEB)': 5, 'Security (SEC)': 1 });
    expect(groups(await data({ client: ctx.admin }, def))).toEqual({ 'Website (WEB)': 5, 'Security (SEC)': 1 });
    // asking for the private project by key gives nothing, not an error
    const sec = await data(bob, { source: { query: { project: 'SEC' } }, kind: 'workload', options: { includeDone: true } });
    expect(sec.body.people).toEqual([]);
    const twoD = await data(bob, { source: { query: {} }, kind: 'twoD', options: { rows: 'project', columns: 'type' } });
    expect(twoD.body.rows.map((x) => x.key)).toEqual(['WEB']);
    const cvr = await data(bob, { source: { query: {} }, kind: 'createdVsResolved', options: { days: 14 } });
    expect(cvr.body.totals.created).toBe(5);
  });

  it('caps groups at 25 plus Other', async () => {
    const id = (await ctx.db.get('SELECT id FROM issues WHERE key = ?', [k.W4])).id;
    for (let i = 0; i < 30; i++)
      await ctx.db.run('INSERT INTO issue_labels (issue_id, label) VALUES (?, ?)', [id, `l${String(i).padStart(2, '0')}`]);
    const r = await data(bob, { source: { query: {} }, kind: 'breakdown', options: { groupBy: 'label' } });
    expect(r.body.groups).toHaveLength(26);
    const other = r.body.groups.at(-1);
    expect(other).toMatchObject({ other: true, label: 'Other (8)', filter: null });
    expect(r.body.groups.reduce((s, g) => s + g.count, 0)).toBe(2 + 1 + 30 + 2);
    expect(r.body.issues).toBe(5);
    const t = await data(bob, { source: { query: {} }, kind: 'twoD', options: { rows: 'type', columns: 'label' } });
    expect(t.body.columns).toHaveLength(11);
    expect(t.body.total).toBe(35);
  });

  it('rejects bad definitions', async () => {
    const bad = async (def, msg) => {
      const r = await data(bob, def);
      expect(r.status).toBe(400);
      if (msg) expect(r.body.error).toMatch(msg);
    };
    await bad({ source: { query: {} }, kind: 'nope' }, /kind must be one of/);
    await bad({ source: { query: {} }, kind: 'breakdown', options: {} }, /groupBy is required/);
    await bad({ source: { query: {} }, kind: 'breakdown', options: { groupBy: 'title' } }, /groupBy must be one of/);
    await bad({ source: { query: {} }, kind: 'breakdown', options: { groupBy: 'type', metric: 'money' } }, /metric/);
    await bad({ source: { query: {} }, kind: 'twoD', options: { rows: 'type', columns: 'type' } }, /two different/);
    await bad({ source: { query: {} }, kind: 'createdVsResolved', options: { period: 'week', days: 1000 } }, /days must be/);
    await bad({ source: { query: {} }, kind: 'createdVsResolved', options: { period: 'day', days: 365 } }, /Daily periods/);
    await bad({ source: { query: {} }, kind: 'list', options: { columns: ['password'] } }, /column must be one of/);
    await bad({ source: { query: {} }, kind: 'list', options: { limit: 500 } }, /limit/);
    await bad({ source: { query: 'all' }, kind: 'workload' }, /query must be an object/);
    await bad({ source: { query: { assignee: { $ne: 1 } } }, kind: 'workload' }, /query.assignee/);
    await bad({ kind: 'workload' }, /source is required/);
    // unknown query keys are dropped, not passed on
    const r = await data(bob, { source: { query: { archived: '1', project: 'WEB' } }, kind: 'workload' });
    expect(r.body.query).toEqual({ project: 'WEB' });
  });
});

describe('saved reports and dashboards', () => {
  const def = { name: 'By project', kind: 'breakdown', source: { query: {} }, options: { groupBy: 'project' } };

  it('a shared report is worked out as each viewer; only the owner or an admin edits it', async () => {
    const r = await bob.client.post('/api/saved-reports', { ...def, visibility: 'shared', description: 'All projects' });
    expect(r.status).toBe(201);
    expect(r.body.report).toMatchObject({
      name: 'By project',
      visibility: 'shared',
      mine: true,
      canEdit: true,
      options: { groupBy: 'project', metric: 'count', chart: 'pie' },
    });
    const id = r.body.report.id;
    expect(groups(await data(bob, { reportId: id }))).toEqual({ 'Website (WEB)': 5 });
    expect(groups(await data(dave, { reportId: id }))).toEqual({ 'Website (WEB)': 5, 'Security (SEC)': 1 });

    const list = await carol.client.get('/api/saved-reports');
    expect(list.body.reports.find((x) => x.id === id)).toMatchObject({ mine: false, canEdit: false, owner: { name: 'Bob' } });
    expect((await carol.client.patch(`/api/saved-reports/${id}`, { name: 'Mine now' })).status).toBe(403);
    expect((await carol.client.del(`/api/saved-reports/${id}`)).status).toBe(403);
    const ad = await ctx.admin.patch(`/api/saved-reports/${id}`, { name: 'Renamed by admin' });
    expect(ad.status).toBe(200);
    expect(ad.body.report.name).toBe('Renamed by admin');
    const up = await bob.client.patch(`/api/saved-reports/${id}`, { kind: 'workload', options: {}, visibility: 'private' });
    expect(up.body.report).toMatchObject({ kind: 'workload', visibility: 'private', options: { includeDone: false } });
    // now private: others cannot see or run it
    expect((await carol.client.get(`/api/saved-reports/${id}`)).status).toBe(404);
    expect((await data(carol, { reportId: id })).status).toBe(404);
    expect((await bob.client.del(`/api/saved-reports/${id}`)).status).toBe(200);
    const auditRows = await ctx.db.all("SELECT action FROM audit_log WHERE target_type = 'report' ORDER BY created_at");
    expect(auditRows.map((a) => a.action).sort()).toEqual(['report.created', 'report.deleted']);
  });

  it('validates saved reports', async () => {
    expect((await bob.client.post('/api/saved-reports', { ...def, name: '' })).status).toBe(400);
    expect((await bob.client.post('/api/saved-reports', { ...def, kind: 'pie' })).status).toBe(400);
    expect((await bob.client.post('/api/saved-reports', { ...def, visibility: 'public' })).status).toBe(400);
    const f = await bob.client.post('/api/filters', { name: 'Private one', query: { project: 'WEB' } });
    const r = await bob.client.post('/api/saved-reports', { ...def, source: { filterId: f.body.id }, visibility: 'shared' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/filter is private/);
    expect((await bob.client.post('/api/saved-reports', { ...def, source: { filterId: f.body.id } })).status).toBe(201);
    expect((await carol.client.post('/api/saved-reports', { ...def, source: { filterId: f.body.id } })).status).toBe(400);
  });

  it('dashboards hold reports; a viewer sees only reports shared with them', async () => {
    const shared = (await bob.client.post('/api/saved-reports', { ...def, visibility: 'shared' })).body.report;
    const priv = (await bob.client.post('/api/saved-reports', { ...def, name: 'Private' })).body.report;
    const d = await bob.client.post('/api/dashboards', {
      name: 'Team',
      visibility: 'shared',
      layout: [{ reportId: shared.id, width: 'full' }, { reportId: priv.id }],
    });
    expect(d.status).toBe(201);
    expect(d.body.dashboard.layout).toEqual([
      { reportId: shared.id, width: 'full' },
      { reportId: priv.id, width: 'half' },
    ]);
    const asCarol = await carol.client.get(`/api/dashboards/${d.body.dashboard.id}`);
    expect(asCarol.body.dashboard.layout.map((x) => x.report?.name ?? null)).toEqual(['By project', null]);
    expect((await carol.client.patch(`/api/dashboards/${d.body.dashboard.id}`, { name: 'x' })).status).toBe(403);
    // carol cannot put Bob's private report on her own dashboard
    expect((await carol.client.post('/api/dashboards', { name: 'Mine', layout: [{ reportId: priv.id }] })).status).toBe(400);
    expect((await carol.client.post('/api/dashboards', { name: 'Mine', layout: [{ reportId: shared.id, width: 'wide' }] })).status).toBe(
      400,
    );
    const re = await bob.client.patch(`/api/dashboards/${d.body.dashboard.id}`, {
      layout: [{ reportId: priv.id, width: 'full' }],
      visibility: 'private',
    });
    expect(re.body.dashboard).toMatchObject({ visibility: 'private', layout: [{ reportId: priv.id, width: 'full' }] });
    expect((await carol.client.get(`/api/dashboards/${d.body.dashboard.id}`)).status).toBe(404);
    expect((await carol.client.get('/api/dashboards')).body.dashboards).toEqual([]);
    expect((await bob.client.del(`/api/dashboards/${d.body.dashboard.id}`)).status).toBe(200);
    const auditRows = await ctx.db.all("SELECT action FROM audit_log WHERE target_type = 'dashboard' ORDER BY created_at");
    expect(auditRows.map((a) => a.action).sort()).toEqual(['dashboard.created', 'dashboard.deleted']);
  });

  it('creates a starter dashboard whose reports all run', async () => {
    const r = await carol.client.post('/api/dashboards/starter', {});
    expect(r.status).toBe(201);
    const d = (await carol.client.get(`/api/dashboards/${r.body.dashboard.id}`)).body.dashboard;
    expect(d.layout).toHaveLength(4);
    expect(d.layout.map((x) => x.report.kind)).toEqual(['breakdown', 'workload', 'createdVsResolved', 'list']);
    const results = await Promise.all(d.layout.map((x) => data(carol, { reportId: x.reportId })));
    expect(results.map((x) => x.status)).toEqual([200, 200, 200, 200]);
    expect(groups(results[0])).toEqual({ 'To Do': 1, 'In Progress': 1 });
    expect(results[3].body.issues.map((i) => i.key)).toEqual([k.W2]);
  });
});

describe('MCP run_report', () => {
  it('runs reports from a query, a saved filter or a saved report', async () => {
    const token = (await bob.client.post('/api/me/tokens', { name: 'Claude' })).body.token;
    let id = 0;
    const tool = async (args) => {
      const res = await ctx.app.request(
        'http://t.example/mcp',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: 'run_report', arguments: args } }),
        },
        ctx.env,
      );
      const r = (await res.json()).result;
      return r.isError ? { error: r.content[0].text } : { data: JSON.parse(r.content[0].text) };
    };
    const q = await tool({ kind: 'breakdown', query: { project: 'WEB' }, options: { groupBy: 'priority' } });
    expect(q.data.groups.map((g) => g.key)).toEqual(['highest', 'high', 'medium', 'low']);
    await bob.client.post('/api/filters', { name: 'Carol work', query: { assignee: carol.id } });
    const f = await tool({ kind: 'workload', filter: 'carol work' });
    expect(f.data.people).toHaveLength(1);
    await bob.client.post('/api/saved-reports', {
      name: 'Everything',
      kind: 'breakdown',
      source: { query: {} },
      options: { groupBy: 'project' },
    });
    const s = await tool({ report: 'Everything' });
    expect(s.data.groups).toEqual([expect.objectContaining({ key: 'WEB', value: 5 })]);
    expect((await tool({ kind: 'workload', filter: 'nope' })).error).toMatch(/No saved filter named "nope"/);
    expect((await tool({ kind: 'breakdown', options: {} })).error).toMatch(/groupBy is required/);
  });
});
