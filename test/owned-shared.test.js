// "Owned plus shared" objects (lib/access.js ownedVisibleSql, canEditOwned): saved reports, dashboards, saved filters,
// board views and project templates. Their rules differ in places; these tests pin each feature's rule as it is today,
// so a later decision to make them the same shows up as a failing test here.
import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser } from './helpers.js';
import { ownedVisibleSql, canEditOwned } from '../server/lib/access.js';

describe('ownedVisibleSql', () => {
  const member = { id: 'u1', role: 'member' };
  const admin = { id: 'a1', role: 'admin' };
  const guest = { id: 'g1', role: 'guest' };

  it('own rows plus shared ones, by visibility column or shared flag', () => {
    expect(ownedVisibleSql(member)).toEqual({ sql: "(owner_id = ? OR visibility = 'shared')", params: ['u1'] });
    expect(ownedVisibleSql(member, { alias: 'r' })).toEqual({ sql: "(r.owner_id = ? OR r.visibility = 'shared')", params: ['u1'] });
    expect(ownedVisibleSql(member, { alias: 'f', shared: 'flag' })).toEqual({ sql: '(f.owner_id = ? OR f.shared = 1)', params: ['u1'] });
  });

  it('a workspace admin gets no more rows than a member', () => {
    expect(ownedVisibleSql(admin, { alias: 'r' })).toEqual({ sql: "(r.owner_id = ? OR r.visibility = 'shared')", params: ['a1'] });
  });

  it('guests get only their own rows unless the caller says otherwise', () => {
    expect(ownedVisibleSql(guest, { alias: 'v', shared: 'flag' })).toEqual({ sql: 'v.owner_id = ?', params: ['g1'] });
    expect(ownedVisibleSql(guest)).toEqual({ sql: 'owner_id = ?', params: ['g1'] });
    expect(ownedVisibleSql(guest, { guests: true })).toEqual({ sql: "(owner_id = ? OR visibility = 'shared')", params: ['g1'] });
  });
});

describe('canEditOwned', () => {
  it('the owner always; a workspace admin only when the caller allows it', () => {
    expect(canEditOwned({ id: 'u1', role: 'member' }, 'u1')).toBe(true);
    expect(canEditOwned({ id: 'u2', role: 'member' }, 'u1')).toBe(false);
    expect(canEditOwned({ id: 'a1', role: 'admin' }, 'u1')).toBe(false);
    expect(canEditOwned({ id: 'a1', role: 'admin' }, 'u1', { admin: true })).toBe(true);
    expect(canEditOwned({ id: 'u2', role: 'member' }, 'u1', { admin: true })).toBe(false);
    expect(canEditOwned({ id: 'u2', role: 'member' }, null, { admin: true })).toBe(false);
  });
});

describe('each feature keeps its own rule', () => {
  let ctx, bob, carol, gina;
  const VIEWS = '/api/projects/WEB/board-views';
  const REPORT = { name: 'By status', source: { query: {} }, kind: 'breakdown', options: { groupBy: 'status' } };

  beforeEach(async () => {
    ctx = await withAdmin();
    bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
    carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
    gina = await addUser(ctx, { email: 'gina@client.example', name: 'Gina', role: 'guest' });
    await bob.client.post('/api/projects', { key: 'WEB', name: 'Website' });
    await bob.client.put(`/api/projects/WEB/members/${gina.id}`, { role: 'guest-edit' });
  });

  it('saved filters: a guest asking to share gets a private filter without an error; only the owner deletes', async () => {
    const g = await gina.client.post('/api/filters', { name: 'Gina filter', query: { project: 'WEB' }, shared: true });
    expect(g.status).toBe(201);
    expect((await gina.client.get('/api/filters')).body.filters).toMatchObject([{ name: 'Gina filter', shared: false, mine: true }]);
    expect((await bob.client.get('/api/filters')).body.filters).toEqual([]);

    const shared = (await bob.client.post('/api/filters', { name: 'Team', query: { project: 'WEB' }, shared: true })).body.id;
    const priv = (await bob.client.post('/api/filters', { name: 'Mine', query: {} })).body.id;
    expect((await carol.client.get('/api/filters')).body.filters.map((f) => f.name)).toEqual(['Team']);
    expect((await gina.client.get('/api/filters')).body.filters.map((f) => f.name)).toEqual(['Gina filter']);
    // not the owner: 404 for a member and for a workspace admin, shared or not
    expect((await carol.client.del(`/api/filters/${shared}`)).status).toBe(404);
    expect((await ctx.admin.del(`/api/filters/${shared}`)).status).toBe(404);
    expect((await ctx.admin.del(`/api/filters/${priv}`)).status).toBe(404);
    expect((await bob.client.del(`/api/filters/${shared}`)).status).toBe(200);
  });

  it('reports and dashboards: a guest sharing is refused; an admin edits shared ones but cannot see private ones', async () => {
    expect((await gina.client.post('/api/saved-reports', { ...REPORT, visibility: 'shared' })).status).toBe(403);
    expect((await gina.client.post('/api/dashboards', { name: 'D', visibility: 'shared' })).status).toBe(403);
    const own = await gina.client.post('/api/saved-reports', REPORT);
    expect(own.status).toBe(201);
    expect((await gina.client.patch(`/api/saved-reports/${own.body.report.id}`, { visibility: 'shared' })).status).toBe(403);

    const priv = (await bob.client.post('/api/saved-reports', REPORT)).body.report.id;
    const shared = (await bob.client.post('/api/saved-reports', { ...REPORT, name: 'Team', visibility: 'shared' })).body.report.id;
    expect((await ctx.admin.patch(`/api/saved-reports/${priv}`, { name: 'x' })).status).toBe(404);
    expect((await ctx.admin.del(`/api/saved-reports/${priv}`)).status).toBe(404);
    expect((await ctx.admin.patch(`/api/saved-reports/${shared}`, { name: 'By admin' })).status).toBe(200);
    expect((await carol.client.patch(`/api/saved-reports/${shared}`, { name: 'x' })).status).toBe(403);
    expect((await gina.client.get(`/api/saved-reports/${shared}`)).status).toBe(404);
    expect((await gina.client.get('/api/saved-reports')).body.reports.map((r) => r.name)).toEqual(['By status']);

    const dPriv = (await bob.client.post('/api/dashboards', { name: 'Private' })).body.dashboard.id;
    const dShared = (await bob.client.post('/api/dashboards', { name: 'Team', visibility: 'shared' })).body.dashboard.id;
    expect((await ctx.admin.patch(`/api/dashboards/${dPriv}`, { name: 'x' })).status).toBe(404);
    expect((await ctx.admin.patch(`/api/dashboards/${dShared}`, { name: 'By admin' })).status).toBe(200);
    expect((await carol.client.del(`/api/dashboards/${dShared}`)).status).toBe(403);
    expect((await gina.client.get('/api/dashboards')).body.dashboards).toEqual([]);
    expect((await ctx.admin.del(`/api/dashboards/${dShared}`)).status).toBe(200);
  });

  it('board views: a guest sharing is refused; only the owner edits, also not a workspace admin; admins delete shared ones', async () => {
    expect((await gina.client.post(VIEWS, { name: 'G', shared: true, filters: {} })).status).toBe(403);
    expect((await gina.client.post(VIEWS, { name: 'G', filters: {} })).status).toBe(201);
    const shared = (await carol.client.post(VIEWS, { name: 'Team', shared: true, filters: {} })).body.view;
    const priv = (await carol.client.post(VIEWS, { name: 'Mine', filters: {} })).body.view;
    expect((await gina.client.get(VIEWS)).body.views.map((v) => v.name)).toEqual(['G']);
    const seen = (await ctx.admin.get(VIEWS)).body.views;
    expect(seen).toMatchObject([{ name: 'Team', mine: false, canEdit: false, canDelete: true }]);
    expect((await ctx.admin.patch(`${VIEWS}/${shared.id}`, { name: 'x' })).status).toBe(403);
    expect((await ctx.admin.patch(`${VIEWS}/${priv.id}`, { name: 'x' })).status).toBe(404);
    expect((await ctx.admin.del(`${VIEWS}/${priv.id}`)).status).toBe(404);
    expect((await ctx.admin.del(`${VIEWS}/${shared.id}`)).status).toBe(200);
  });

  it('project templates: an admin changes a private one of someone else, though it is not in their list', async () => {
    const t = await bob.client.post('/api/project-templates', { projectKey: 'WEB', name: 'Bob way' });
    expect(t.status).toBe(201);
    const id = t.body.template.id;
    const ids = async (who, q = '') => (await who.get(`/api/project-templates${q}`)).body.templates.map((x) => x.id);
    expect(await ids(ctx.admin)).not.toContain(id);
    expect(await ids(ctx.admin, '?all=1')).toEqual([id]);
    expect((await ctx.admin.post('/api/projects', { key: 'ADM', name: 'Admin', templateId: id })).status).toBe(400); // not shared: an admin cannot use it either
    expect((await carol.client.patch(`/api/project-templates/${id}`, { name: 'x' })).status).toBe(404);
    const ren = await ctx.admin.patch(`/api/project-templates/${id}`, { name: 'Renamed' });
    expect(ren.status).toBe(200);
    expect(ren.body.template).toMatchObject({ name: 'Renamed', canEdit: true });
    expect((await gina.client.get('/api/project-templates')).status).toBe(403);
  });
});
