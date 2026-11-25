// Saved board views (migration 0020, server/routes/boardViews.js).
import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser } from './helpers.js';
import { BACKUP_SCHEMA } from '../server/lib/backup.js';

let ctx, bob, carol, gina, vic;
// CLI: private, Bob's (project admin as creator); Carol member; Gina guest; Vic viewer member.
beforeEach(async () => {
  ctx = await withAdmin();
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
  gina = await addUser(ctx, { email: 'gina@client.example', name: 'Gina Guest', role: 'guest' });
  vic = await addUser(ctx, { email: 'vic@example.com', name: 'Vic', role: 'viewer' });
  await bob.client.post('/api/projects', { key: 'CLI', name: 'Client portal', visibility: 'private' });
  await bob.client.post('/api/projects', { key: 'OPS', name: 'Operations', visibility: 'private' });
  for (const [who, role] of [
    [carol, 'member'],
    [gina, 'guest-view'],
    [vic, 'viewer'],
  ])
    await bob.client.put(`/api/projects/CLI/members/${who.id}`, { role });
});

const URL = '/api/projects/CLI/board-views';
const FILTERS = {
  scope: 'all',
  text: 'login',
  mine: true,
  assignees: ['none'],
  type: 'bug',
  label: 'ui',
  subtasks: true,
  lanes: 'assignee',
  oldDone: true,
};
/** The admin's session cookie (the backup is a streamed download). */
async function adminCookie() {
  let cookie = '';
  const orig = ctx.app.request.bind(ctx.app);
  ctx.app.request = (path, init, env) => {
    cookie = init.headers.cookie;
    return orig(path, init, env);
  };
  await ctx.admin.get('/api/me');
  ctx.app.request = orig;
  return cookie;
}
const names = async (who) => (await who.client.get(URL)).body.views.map((v) => v.name);

describe('board views', () => {
  it('saves, lists, switches and remembers a default', async () => {
    const r = await carol.client.post(URL, { name: 'My bugs', filters: { ...FILTERS, extra: 'dropped', type: 'nonsense' } });
    expect(r.status).toBe(201);
    expect(r.body.view).toMatchObject({
      name: 'My bugs',
      shared: false,
      mine: true,
      canEdit: true,
      canDelete: true,
      owner: { name: 'Carol' },
    });
    expect(r.body.view.filters).toEqual({ ...FILTERS, type: '' });
    await carol.client.post(URL, { name: 'Everything', filters: { scope: 'sprint' } });
    let list = (await carol.client.get(URL)).body;
    expect(list.views.map((v) => v.name)).toEqual(['Everything', 'My bugs']);
    expect(list.defaultId).toBe(null);
    expect(list.canShare).toBe(true);
    expect((await carol.client.put(`${URL}/default`, { viewId: r.body.view.id })).body.defaultId).toBe(r.body.view.id);
    list = (await carol.client.get(URL)).body;
    expect(list.defaultId).toBe(r.body.view.id);
    expect((await bob.client.get(URL)).body.defaultId).toBe(null); // per person
    expect((await carol.client.get('/api/projects/OPS/board-views')).status).toBe(404); // not a member
    expect((await carol.client.put(`${URL}/default`, { viewId: null })).body.defaultId).toBe(null);
  });

  it('keeps private views private and shows shared ones to the team, not to guests', async () => {
    await carol.client.post(URL, { name: 'Carol private', filters: {} });
    await carol.client.post(URL, { name: 'Team view', shared: true, filters: {} });
    expect(await names(bob)).toEqual(['Team view']);
    expect(await names(vic)).toEqual(['Team view']);
    expect(await names(gina)).toEqual([]);
    const own = await gina.client.post(URL, { name: 'Gina view', filters: { text: 'x' } });
    expect(own.status).toBe(201);
    expect(await names(gina)).toEqual(['Gina view']);
    expect((await gina.client.post(URL, { name: 'Gina shared', shared: true, filters: {} })).status).toBe(403);
    expect((await gina.client.patch(`${URL}/${own.body.view.id}`, { shared: true })).status).toBe(403);
    expect((await gina.client.get(URL)).body.canShare).toBe(false);
    // viewers may keep private views but cannot share
    expect((await vic.client.post(URL, { name: 'Vic', shared: true, filters: {} })).status).toBe(403);
    expect((await vic.client.post(URL, { name: 'Vic', filters: {} })).status).toBe(201);
  });

  it('a default pointing at a view that went private counts as none', async () => {
    const v = (await carol.client.post(URL, { name: 'Team', shared: true, filters: {} })).body.view;
    await bob.client.put(`${URL}/default`, { viewId: v.id });
    expect((await bob.client.get(URL)).body.defaultId).toBe(v.id);
    await carol.client.patch(`${URL}/${v.id}`, { shared: false });
    expect((await bob.client.get(URL)).body).toMatchObject({ views: [], defaultId: null });
    const priv = (await carol.client.post(URL, { name: 'Mine', filters: {} })).body.view;
    expect((await bob.client.put(`${URL}/default`, { viewId: priv.id })).status).toBe(404);
  });

  it('rename and update only by the owner; delete by the owner or a project admin for shared views', async () => {
    const shared = (await carol.client.post(URL, { name: 'Team', shared: true, filters: {} })).body.view;
    const priv = (await carol.client.post(URL, { name: 'Private', filters: {} })).body.view;
    expect((await bob.client.patch(`${URL}/${shared.id}`, { name: 'Taken' })).status).toBe(403);
    const ren = await carol.client.patch(`${URL}/${shared.id}`, { name: 'Team board', filters: { lanes: 'epic' } });
    expect(ren.body.view).toMatchObject({ name: 'Team board', shared: true });
    expect(ren.body.view.filters.lanes).toBe('epic');
    const asBob = (await bob.client.get(URL)).body.views[0];
    expect(asBob).toMatchObject({ mine: false, canEdit: false, canDelete: true });
    expect((await bob.client.del(`${URL}/${priv.id}`)).status).toBe(404); // cannot even see it
    const other = await addUser(ctx, { email: 'dan@example.com', name: 'Dan' });
    await bob.client.put(`/api/projects/CLI/members/${other.id}`, { role: 'member' });
    expect((await other.client.del(`${URL}/${shared.id}`)).status).toBe(403);
    await other.client.put(`${URL}/default`, { viewId: shared.id });
    expect((await bob.client.del(`${URL}/${shared.id}`)).status).toBe(200); // project admin
    expect((await other.client.get(URL)).body).toMatchObject({ views: [], defaultId: null });
    expect((await carol.client.del(`${URL}/${priv.id}`)).status).toBe(200);
    expect(await names(carol)).toEqual([]);
  });

  it('is in the full backup, with comment reactions and threads', async () => {
    const v = (await carol.client.post(URL, { name: 'Team', shared: true, filters: {} })).body.view;
    await carol.client.put(`${URL}/default`, { viewId: v.id });
    await bob.client.post('/api/issues', { projectKey: 'CLI', title: 'Task' });
    const top = (await bob.client.post('/api/issues/CLI-1/comments', { body: 'Top' })).body.comment;
    await carol.client.post('/api/issues/CLI-1/comments', { body: 'Reply', parentId: top.id });
    await carol.client.post(`/api/comments/${top.id}/reactions/check`);
    const b = JSON.parse(await (await ctx.app.request('/api/admin/backup', { headers: { cookie: await adminCookie() } }, ctx.env)).text());
    expect(b.schema).toBe(BACKUP_SCHEMA);
    expect(b.tables.board_views).toHaveLength(1);
    expect(b.tables.board_view_defaults).toEqual([expect.objectContaining({ view_id: v.id })]);
    expect(b.tables.comment_reactions).toEqual([expect.objectContaining({ comment_id: top.id, reaction: 'check' })]);
    expect(b.tables.comments.find((c) => c.body === 'Reply').parent_id).toBe(top.id);
    expect(b.tableOrder.indexOf('comment_reactions')).toBeGreaterThan(b.tableOrder.indexOf('comments'));
  });

  it('checks names and filters', async () => {
    expect((await carol.client.post(URL, { name: '', filters: {} })).status).toBe(400);
    expect((await carol.client.post(URL, { name: 'x'.repeat(81), filters: {} })).status).toBe(400);
    expect((await carol.client.post(URL, { name: 'Bad', filters: [] })).status).toBe(400);
    expect((await carol.client.post(URL, { name: 'Bad', filters: { assignees: [1, 2] } })).status).toBe(400);
  });
});
