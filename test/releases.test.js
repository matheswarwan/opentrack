import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser, client } from './helpers.js';
import { localParts } from '../server/lib/time.js';
import { guessMapping, mapRows, parseCsv } from '../src/csv.js';
import { STANDARD_REPORTS, standardDefinition } from '../src/standardReports.js';

let ctx, bob, carol, dave, web;

beforeEach(async () => {
  ctx = await withAdmin({ PUBLIC_URL: 'https://tracker.example.com' });
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' }); // creates WEB: project admin (lead)
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' }); // a member of an open project
  dave = await addUser(ctx, { email: 'dave@example.com', name: 'Dave' });
  web = (await bob.client.post('/api/projects', { key: 'web', name: 'Website' })).body.project;
});

const ok = (r, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const component = async (data) => ok(await bob.client.post('/api/projects/WEB/components', data), 201).component;
const release = async (data) => ok(await bob.client.post('/api/projects/WEB/releases', data), 201).release;
const issue = async (data = {}, who = bob) =>
  ok(await who.client.post('/api/issues', { projectKey: 'WEB', title: 'Issue', ...data }), 201).issue;
const keys = async (who, q) =>
  (await who.client.get(`/api/issues?project=WEB&${new URLSearchParams(q)}`)).body.issues.map((i) => i.key).sort();
const doneId = () => web.statuses.find((s) => s.category === 'done').id;
const inProgressId = () => web.statuses.find((s) => s.category === 'in_progress').id;

describe('components', () => {
  it('project admins manage components; members can list them', async () => {
    expect((await carol.client.post('/api/projects/WEB/components', { name: 'API' })).status).toBe(403);
    const api = await component({ name: 'API', description: 'Backend', leadId: bob.id, defaultAssigneeId: carol.id });
    expect(api).toMatchObject({
      name: 'API',
      description: 'Backend',
      lead: { id: bob.id, name: 'Bob' },
      defaultAssignee: { id: carol.id, name: 'Carol' },
    });
    expect((await bob.client.post('/api/projects/WEB/components', { name: 'api' })).status).toBe(409);
    expect((await bob.client.post('/api/projects/WEB/components', { name: 'X', defaultAssigneeId: 'nobody' })).status).toBe(400);
    const list = ok(await carol.client.get('/api/projects/WEB/components'));
    expect(list.components.map((c) => c.name)).toEqual(['API']);
    expect(list.canAdmin).toBe(false);
    expect((await carol.client.patch(`/api/projects/WEB/components/${api.id}`, { name: 'Y' })).status).toBe(403);
    const edited = ok(
      await bob.client.patch(`/api/projects/WEB/components/${api.id}`, { name: 'Backend API', defaultAssigneeId: null }),
    ).component;
    expect(edited).toMatchObject({ name: 'Backend API', defaultAssignee: null });
    // the project payload lists them for pickers
    expect((await carol.client.get('/api/projects/WEB')).body.project.components).toEqual([
      { id: api.id, name: 'Backend API', defaultAssigneeId: null },
    ]);
    expect((await carol.client.del(`/api/projects/WEB/components/${api.id}`)).status).toBe(403);
    expect((await bob.client.del(`/api/projects/WEB/components/${api.id}`)).status).toBe(200);
    expect(ok(await bob.client.get('/api/projects/WEB/components')).components).toEqual([]);
  });

  it('a default assignee of a private project must be able to see it', async () => {
    await bob.client.patch('/api/projects/WEB', { visibility: 'private' });
    expect((await bob.client.post('/api/projects/WEB/components', { name: 'UI', defaultAssigneeId: dave.id })).status).toBe(400);
    await bob.client.put(`/api/projects/WEB/members/${dave.id}`, { role: 'member' });
    expect((await bob.client.post('/api/projects/WEB/components', { name: 'UI', defaultAssigneeId: dave.id })).status).toBe(201);
  });

  it('a component with a default assignee assigns unassigned issues, with history', async () => {
    const ui = await component({ name: 'UI', defaultAssigneeId: carol.id });
    const api = await component({ name: 'API' });
    // create: unassigned issue gets Carol
    const a = await issue({ components: ['ui'] });
    expect(a.assignee?.id).toBe(carol.id);
    expect(a.components).toEqual([{ id: ui.id, name: 'UI' }]);
    const hist = (await bob.client.get(`/api/issues/${a.key}`)).body.issue.history;
    expect(hist.some((h) => h.field === 'assignee' && h.to === 'Carol')).toBe(true);
    const note = await carol.client.get('/api/notifications');
    expect(JSON.stringify(note.body)).toContain(a.key);
    // an assignee given wins
    expect((await issue({ components: [ui.id], assigneeId: bob.id })).assignee.id).toBe(bob.id);
    // update: adding the component to an unassigned issue assigns; an assigned one keeps its assignee
    const b = await issue({ components: [api.id] });
    expect(b.assignee).toBeNull();
    const r = ok(await bob.client.patch(`/api/issues/${b.key}`, { components: [api.id, ui.id] }));
    expect(r.changed).toEqual(expect.arrayContaining(['components', 'assignee']));
    expect(r.issue.assignee.id).toBe(carol.id);
    expect(r.issue.components.map((c) => c.name)).toEqual(['API', 'UI']);
    const c = await issue({ assigneeId: bob.id });
    expect(ok(await bob.client.patch(`/api/issues/${c.key}`, { components: [ui.id] })).issue.assignee.id).toBe(bob.id);
    // a deactivated default assignee is skipped
    await ctx.admin.patch(`/api/admin/users/${carol.id}`, { status: 'deactivated' });
    expect((await issue({ components: [ui.id] })).assignee).toBeNull();
  });

  it('deleting a component can move its issues to another one', async () => {
    const a = await component({ name: 'A' });
    const b = await component({ name: 'B' });
    const i = await issue({ components: ['A'] });
    expect((await bob.client.del(`/api/projects/WEB/components/${a.id}?moveTo=${a.id}`)).status).toBe(400);
    ok(await bob.client.del(`/api/projects/WEB/components/${a.id}?moveTo=${b.id}`));
    expect((await bob.client.get(`/api/issues/${i.key}`)).body.issue.components).toEqual([{ id: b.id, name: 'B' }]);
  });
});

describe('releases', () => {
  it('project admins create, edit, archive and delete releases', async () => {
    expect((await carol.client.post('/api/projects/WEB/releases', { name: '1.0' })).status).toBe(403);
    const v1 = await release({ name: '1.0', description: 'First', startDate: '2026-01-01', releaseDate: '2026-02-01' });
    expect(v1).toMatchObject({
      name: '1.0',
      status: 'unreleased',
      startDate: '2026-01-01',
      releaseDate: '2026-02-01',
      overdue: true,
      releasedAt: null,
    });
    expect((await bob.client.post('/api/projects/WEB/releases', { name: '1.0' })).status).toBe(409);
    expect(
      (await bob.client.post('/api/projects/WEB/releases', { name: 'Bad', startDate: '2026-03-01', releaseDate: '2026-02-01' })).status,
    ).toBe(400);
    const v2 = await release({ name: '2.0', releaseDate: '2999-01-01' });
    expect(v2.overdue).toBe(false);
    expect((await carol.client.patch(`/api/projects/WEB/releases/${v1.id}`, { name: 'x' })).status).toBe(403);
    expect((await bob.client.patch(`/api/projects/WEB/releases/${v1.id}`, { status: 'released' })).status).toBe(400);
    const renamed = ok(await bob.client.patch(`/api/projects/WEB/releases/${v1.id}`, { name: '1.0.0', releaseDate: null })).release;
    expect(renamed).toMatchObject({ name: '1.0.0', releaseDate: null, overdue: false });
    const list = ok(await carol.client.get('/api/projects/WEB/releases'));
    expect(list.releases.map((r) => r.name)).toEqual(['2.0', '1.0.0']); // dated first
    // archived releases cannot be picked for issues
    ok(await bob.client.patch(`/api/projects/WEB/releases/${v2.id}`, { status: 'archived' }));
    expect((await bob.client.post('/api/issues', { projectKey: 'WEB', title: 'x', fixVersions: ['2.0'] })).status).toBe(400);
    ok(await bob.client.patch(`/api/projects/WEB/releases/${v2.id}`, { status: 'unreleased' }));
    const i = await issue({ fixVersions: ['2.0'] });
    ok(await bob.client.del(`/api/projects/WEB/releases/${v2.id}?moveTo=${v1.id}`));
    expect((await bob.client.get(`/api/issues/${i.key}`)).body.issue.fixVersions.map((v) => v.name)).toEqual(['1.0.0']);
  });

  it('issues join components and fix versions through create, update and bulk, with history', async () => {
    const ui = await component({ name: 'UI' });
    const api = await component({ name: 'API' });
    const v1 = await release({ name: '1.0' });
    const v2 = await release({ name: '2.0' });
    const a = await issue({ components: ['UI', api.id], fixVersions: ['1.0'] }, carol); // members can set them
    expect(a.components.map((c) => c.name)).toEqual(['API', 'UI']);
    expect(a.fixVersions).toEqual([{ id: v1.id, name: '1.0', status: 'unreleased', releaseDate: null }]);
    expect((await bob.client.post('/api/issues', { projectKey: 'WEB', title: 'x', components: ['Nope'] })).status).toBe(400);
    const r = ok(await carol.client.patch(`/api/issues/${a.key}`, { fixVersions: [v2.id], components: [] }));
    expect(r.changed.sort()).toEqual(['components', 'fix_versions']);
    const hist = (await bob.client.get(`/api/issues/${a.key}`)).body.issue.history;
    expect(hist.find((h) => h.field === 'fix_versions')).toMatchObject({ from: '1.0', to: '2.0' });
    expect(hist.find((h) => h.field === 'components')).toMatchObject({ from: 'API, UI', to: null });
    // no change, no history
    expect(ok(await carol.client.patch(`/api/issues/${a.key}`, { fixVersions: ['2.0'] })).changed).toEqual([]);
    // dave cannot edit a private project's issue
    await bob.client.patch('/api/projects/WEB', { visibility: 'private' });
    expect((await dave.client.patch(`/api/issues/${a.key}`, { components: [ui.id] })).status).toBe(404);
    await bob.client.patch('/api/projects/WEB', { visibility: 'open' });
    // bulk add and remove
    const b = await issue({ components: [ui.id] });
    const c = await issue();
    const bulk = ok(
      await bob.client.post('/api/issues/bulk', {
        keys: [a.key, b.key, c.key],
        changes: { addComponents: ['API'], addFixVersions: [v1.id], removeFixVersions: ['2.0'] },
      }),
    );
    expect(bulk.updated).toBe(3);
    const got = async (k) => (await bob.client.get(`/api/issues/${k}`)).body.issue;
    expect((await got(a.key)).components.map((x) => x.name)).toEqual(['API']);
    expect((await got(a.key)).fixVersions.map((x) => x.name)).toEqual(['1.0']);
    expect((await got(b.key)).components.map((x) => x.name)).toEqual(['API', 'UI']);
    const rm = ok(await bob.client.post('/api/issues/bulk', { keys: [b.key], changes: { removeComponents: [ui.id, 'Gone'] } }));
    expect(rm.updated).toBe(1);
    expect((await got(b.key)).components.map((x) => x.name)).toEqual(['API']);
    expect((await bob.client.post('/api/issues/bulk', { keys: [b.key], changes: { addComponents: ['API'], components: [] } })).status).toBe(
      400,
    );
    // a component of another project is not found
    await bob.client.post('/api/projects', { key: 'OPS', name: 'Ops' });
    const other = ok(await bob.client.post('/api/projects/OPS/components', { name: 'Infra' }), 201).component;
    expect((await bob.client.patch(`/api/issues/${c.key}`, { components: [other.id] })).status).toBe(400);
  });

  it('search filters by component and fix version, including none', async () => {
    const ui = await component({ name: 'UI' });
    await component({ name: 'API' });
    const v1 = await release({ name: '1.0' });
    const a = await issue({ components: ['UI'], fixVersions: ['1.0'] });
    const b = await issue({ components: ['API'] });
    const c = await issue();
    expect(await keys(bob, { component: ui.id })).toEqual([a.key]);
    expect(await keys(bob, { component: 'api' })).toEqual([b.key]);
    expect(await keys(bob, { component: 'none' })).toEqual([c.key]);
    expect(await keys(bob, { component: `${ui.id},none` })).toEqual([a.key, c.key].sort());
    expect(await keys(bob, { fixVersion: v1.id })).toEqual([a.key]);
    expect(await keys(bob, { fixVersion: 'none' })).toEqual([b.key, c.key].sort());
    expect(await keys(bob, { fixVersion: '1.0', component: 'API' })).toEqual([]);
    const list = (await bob.client.get('/api/issues?project=WEB&withReleases=1&component=UI')).body.issues[0];
    expect(list.components[0].name).toBe('UI');
    expect((await bob.client.get('/api/issues?project=WEB')).body.issues[0].components).toBeUndefined();
  });
});

describe('release page, progress and the Release action', () => {
  async function setup() {
    const v1 = await release({ name: '1.0', description: 'The first one.' });
    const v2 = await release({ name: '1.1' });
    const story = await issue({ type: 'story', title: 'Sign up page', fixVersions: [v1.id], storyPoints: 5, statusId: doneId() });
    const task = await issue({ type: 'task', title: 'Faster builds', fixVersions: [v1.id], storyPoints: 3, statusId: doneId() });
    const bug = await issue({ type: 'bug', title: 'Login fails', fixVersions: [v1.id, v2.id], storyPoints: 2, statusId: inProgressId() });
    const open = await issue({ type: 'task', title: 'Docs', fixVersions: [v1.id], storyPoints: 1 });
    const trashed = await issue({ title: 'Deleted', fixVersions: [v1.id], storyPoints: 8 });
    ok(await bob.client.del(`/api/issues/${trashed.key}`));
    return { v1, v2, story, task, bug, open };
  }

  it('progress counts issues and points, without the Trash', async () => {
    const { v1 } = await setup();
    const list = ok(await carol.client.get('/api/projects/WEB/releases'));
    const p = list.releases.find((r) => r.id === v1.id).progress;
    expect(p).toEqual({ total: 4, done: 2, inProgress: 1, points: 11, pointsDone: 8 });
    const page = ok(await carol.client.get(`/api/projects/WEB/releases/${v1.id}`));
    expect(page.release.progress.total).toBe(4);
    expect(page.issues.map((i) => i.title).sort()).toEqual(['Docs', 'Faster builds', 'Login fails', 'Sign up page']);
    expect(page.canAdmin).toBe(false);
    expect(page.moveTargets.map((r) => r.name)).toEqual(['1.1']);
  });

  it('Release is refused while issues are open; release anyway moves them or takes the version off', async () => {
    const { v1, v2, bug, open } = await setup();
    expect((await carol.client.post(`/api/projects/WEB/releases/${v1.id}/release`, {})).status).toBe(403);
    const refused = await bob.client.post(`/api/projects/WEB/releases/${v1.id}/release`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.open).toBe(2);
    expect((await bob.client.post(`/api/projects/WEB/releases/${v1.id}/release`, { moveOpenTo: v1.id })).status).toBe(400);
    const r = ok(await bob.client.post(`/api/projects/WEB/releases/${v1.id}/release`, { moveOpenTo: v2.id, releaseDate: '2026-11-19' }));
    expect(r).toMatchObject({ moved: 2, movedTo: { name: '1.1' } });
    expect(r.release).toMatchObject({ status: 'released', releaseDate: '2026-11-19' });
    expect(r.release.releasedAt).toBeTruthy();
    expect(r.release.progress).toMatchObject({ total: 2, done: 2 });
    const o = (await bob.client.get(`/api/issues/${open.key}`)).body.issue;
    expect(o.fixVersions.map((v) => v.name)).toEqual(['1.1']);
    expect(o.history.find((h) => h.field === 'fix_versions')).toMatchObject({ from: '1.0', to: '1.1' });
    const b = (await bob.client.get(`/api/issues/${bug.key}`)).body.issue;
    expect(b.fixVersions.map((v) => v.name)).toEqual(['1.1']);
    expect(b.history.find((h) => h.field === 'fix_versions')).toMatchObject({ from: '1.0, 1.1', to: '1.1' });
    expect((await bob.client.post(`/api/projects/WEB/releases/${v1.id}/release`, {})).status).toBe(400); // already released
    // release anyway with no target: open issues lose the version
    const v3 = await release({ name: '2.0' });
    const x = await issue({ fixVersions: [v3.id] });
    ok(await bob.client.post(`/api/projects/WEB/releases/${v2.id}/release`, { moveOpenTo: null }));
    expect((await bob.client.get(`/api/issues/${bug.key}`)).body.issue.fixVersions).toEqual([]);
    // all done: releases at once; release date defaults to today
    ok(await bob.client.patch(`/api/issues/${x.key}`, { statusId: doneId() }));
    const done = ok(await bob.client.post(`/api/projects/WEB/releases/${v3.id}/release`, {}));
    expect(done.release.releaseDate).toBe(localParts(Date.now(), 'America/Vancouver').date); // the workspace day
    // unrelease
    expect(ok(await bob.client.patch(`/api/projects/WEB/releases/${v3.id}`, { status: 'unreleased' })).release).toMatchObject({
      status: 'unreleased',
      releasedAt: null,
    });
  });

  it('release notes group done issues by type', async () => {
    const { v1, story, task } = await setup();
    const n = ok(await carol.client.get(`/api/projects/WEB/releases/${v1.id}/notes`));
    expect(n.filename).toBe('WEB-1.0-release-notes.md');
    expect(n.markdown).toContain('# Website 1.0');
    expect(n.markdown).toContain('The first one.');
    expect(n.markdown).toContain(`## Features\n\n- [${story.key}](https://tracker.example.com/browse/${story.key}) Sign up page`);
    expect(n.markdown).toContain(`## Improvements\n\n- [${task.key}](https://tracker.example.com/browse/${task.key}) Faster builds`);
    expect(n.markdown).not.toContain('Bug fixes'); // the bug is not done
    expect(n.markdown).not.toContain('Deleted');
    expect(n.markdown).toContain('2 issues are not done and are not listed.');
    const file = await carol.client.get(`/api/projects/WEB/releases/${v1.id}/notes?download=1`);
    expect(file.headers.get('content-disposition')).toContain('WEB-1.0-release-notes.md');
    expect(file.body).toContain('## Features');
  });

  it('private projects keep components and releases from non-members', async () => {
    const { v1 } = await setup();
    await component({ name: 'UI' });
    await bob.client.patch('/api/projects/WEB', { visibility: 'private' });
    for (const path of [
      '/api/projects/WEB/components',
      '/api/projects/WEB/releases',
      `/api/projects/WEB/releases/${v1.id}`,
      `/api/projects/WEB/releases/${v1.id}/notes`,
    ]) {
      expect((await dave.client.get(path)).status).toBe(404);
    }
    expect((await dave.client.get(`/api/issues?fixVersion=${v1.id}`)).body.issues).toEqual([]);
    expect((await dave.client.get('/api/issues?component=UI')).body.issues).toEqual([]);
  });
});

describe('everywhere else', () => {
  it('CSV export and Sheets feeds have the columns', async () => {
    await component({ name: 'UI' });
    await component({ name: 'API' });
    await release({ name: '1.0' });
    await issue({ title: 'Exported', components: ['UI', 'API'], fixVersions: ['1.0'] });
    const [head, row] = (await bob.client.get('/api/issues.csv?project=WEB')).body.split('\n');
    expect(head).toContain('Labels,Components,Fix versions,Created');
    expect(row).toContain(',"API, UI",1.0,');
    const cols = ok(await carol.client.get('/api/feeds')).columns.map((c) => c.id);
    expect(cols).toEqual(expect.arrayContaining(['components', 'fixVersions']));
    const f = ok(
      await carol.client.post('/api/feeds', {
        name: 'Plan',
        query: { project: 'WEB', component: 'UI' },
        columns: ['key', 'components', 'fixVersions'],
      }),
      201,
    );
    const anon = client(ctx);
    const csv = (await anon.get(new URL(f.url).pathname)).body.trim().split('\n');
    expect(csv).toEqual(['Key,Components,Fix versions', 'WEB-1,"API, UI",1.0']);
  });

  it('CSV import maps Jira Component/s and Fix Version/s and creates missing ones for admins', async () => {
    const ui = await component({ name: 'UI', defaultAssigneeId: carol.id });
    const text = 'Summary,Component/s,Component/s,Fix Version/s\nOne,UI,API,1.0\nTwo,UI,,';
    const rows = parseCsv(text);
    const map = guessMapping(rows[0], rows.slice(1));
    expect(map.components).toBe(1);
    expect(map.fix_versions).toBe(3);
    const api = mapRows(rows, map);
    expect(api[0]).toMatchObject({ title: 'One', components: ['UI', 'API'], fix_versions: ['1.0'] });
    expect(api[1].components).toEqual(['UI']);
    // a member cannot create components by importing
    const dry = ok(await carol.client.post('/api/projects/WEB/import', { rows: api, dryRun: true }));
    expect(dry.valid).toBe(false);
    expect(dry.rows[0].errors.join(' ')).toContain('Component not found: API');
    const r = ok(await bob.client.post('/api/projects/WEB/import', { rows: api }), 201);
    expect(r.created).toHaveLength(2);
    const one = (await bob.client.get(`/api/issues/${r.created[0].key}`)).body.issue;
    expect(one.components.map((c) => c.name)).toEqual(['API', 'UI']);
    expect(one.fixVersions.map((v) => v.name)).toEqual(['1.0']);
    expect(one.assignee.id).toBe(carol.id); // UI's default assignee
    expect(ok(await bob.client.get('/api/projects/WEB/components')).components.map((c) => c.name)).toEqual(['API', 'UI']);
    expect(ok(await bob.client.get('/api/projects/WEB/releases')).releases.map((v) => v.name)).toEqual(['1.0']);
    expect(ui.id).toBeTruthy();
  });

  it('templates hold default components', async () => {
    const ui = await component({ name: 'UI' });
    const t = ok(await bob.client.post('/api/projects/WEB/templates', { name: 'UI bug', type: 'bug', components: ['UI'] }), 201).template;
    expect(t.components).toEqual([ui.id]);
    expect((await bob.client.post('/api/projects/WEB/templates', { name: 'Bad', components: ['Nope'] })).status).toBe(400);
    await bob.client.del(`/api/projects/WEB/components/${ui.id}`);
    expect(ok(await bob.client.get('/api/projects/WEB/templates')).templates[0].components).toEqual([]);
  });

  it('custom reports group by component and fix version', async () => {
    const ui = await component({ name: 'UI' });
    await component({ name: 'API' });
    const v1 = await release({ name: '1.0' });
    await issue({ components: ['UI', 'API'], fixVersions: ['1.0'], storyPoints: 2 });
    await issue({ components: ['UI'], storyPoints: 3 });
    await issue();
    const b = ok(
      await carol.client.post('/api/report-data', {
        source: { query: { project: 'WEB' } },
        kind: 'breakdown',
        options: { groupBy: 'component' },
      }),
    );
    expect(b.groupLabel).toBe('Component');
    expect(Object.fromEntries(b.groups.map((g) => [g.label, g.count]))).toEqual({ UI: 2, API: 1, 'No component': 1 });
    expect(b.issues).toBe(3);
    expect(b.groups.find((g) => g.label === 'UI').filter).toEqual({ component: ui.id });
    expect(b.groups.find((g) => g.label === 'No component').filter).toEqual({ component: 'none' });
    const t = ok(
      await carol.client.post('/api/report-data', {
        source: { query: { project: 'WEB' } },
        kind: 'twoD',
        options: { rows: 'fixVersion', columns: 'component', metric: 'storyPoints' },
      }),
    );
    expect(t.rowsLabel).toBe('Fix version');
    const row = t.rows.findIndex((r) => r.label === '1.0');
    expect(t.rows[row].filter).toEqual({ fixVersion: v1.id });
    expect(t.cells[row][t.columns.findIndex((c) => c.label === 'UI')]).toBe(2);
    // a saved report keeps the filters
    const saved = await carol.client.post('/api/saved-reports', {
      name: 'R',
      source: { query: { project: 'WEB', fixVersion: v1.id } },
      kind: 'list',
      options: {},
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    // the release standard reports run
    for (const r of STANDARD_REPORTS.filter((x) => x.group === 'Releases and components')) {
      ok(await carol.client.post('/api/report-data', standardDefinition(r, 'WEB')));
    }
  });

  it('MCP: components and fix versions by name, list_releases with notes', async () => {
    await component({ name: 'UI', defaultAssigneeId: carol.id });
    await release({ name: '1.0', releaseDate: '2026-01-01' });
    const token = ok(await bob.client.post('/api/me/tokens', { name: 'AI' }), 201).token;
    let id = 0;
    const tool = async (name, args = {}) => {
      const res = await ctx.app.request(
        'http://t.example/mcp',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
        },
        ctx.env,
      );
      const r = (await res.json()).result;
      if (r.isError) throw new Error(r.content[0].text);
      return JSON.parse(r.content[0].text);
    };
    const projects = await tool('list_projects');
    expect(projects[0]).toMatchObject({ components: ['UI'], unreleasedVersions: ['1.0'] });
    const created = await tool('create_issue', {
      project: 'WEB',
      title: 'Via AI',
      type: 'story',
      components: ['ui'],
      fix_versions: ['1.0'],
    });
    expect(created).toMatchObject({ components: ['UI'], fix_versions: ['1.0'], assignee: 'Carol' });
    const got = await tool('get_issue', { key: created.created });
    expect(got.fix_versions).toEqual(['1.0']);
    const upd = await tool('update_issue', { key: created.created, components: [] });
    expect(upd.changed).toEqual(['components']);
    const found = await tool('search_issues', { project: 'WEB', fix_version: '1.0' });
    expect(found.issues.map((i) => i.key)).toEqual([created.created]);
    const rel = await tool('list_releases', { project: 'WEB', release: '1.0' });
    expect(rel.releases[0]).toMatchObject({ name: '1.0', status: 'unreleased', overdue: true, issues: { done: 0, total: 1 } });
    expect(rel.notes).toContain('# Website 1.0');
    await expect(tool('list_releases', { project: 'WEB', release: 'Nope' })).rejects.toThrow('No release "Nope"');
  });

  it('backups include the new tables', async () => {
    await component({ name: 'UI' });
    await release({ name: '1.0' });
    await issue({ components: ['UI'], fixVersions: ['1.0'] });
    const { TABLES } = await import('../server/lib/backup.js');
    const names = TABLES.map((t) => t.name);
    for (const t of ['components', 'issue_components', 'releases', 'issue_releases']) expect(names).toContain(t);
    expect(names.indexOf('components')).toBeGreaterThan(names.indexOf('issues'));
  });
});
