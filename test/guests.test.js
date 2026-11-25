// Guests (external clients): workspace role 'guest', project levels guest-view / guest-comment / guest-edit,
// internal notes. Rules live in server/lib/access.js.
import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser } from './helpers.js';
import { STANDARD_REPORTS, standardDefinition } from '../src/standardReports.js';

let ctx, bob, carol, gina;
// WEB: open, Bob's. CLI: members only, Bob's, Gina is a guest there. OPS: members only, Gina not in it.
beforeEach(async () => {
  ctx = await withAdmin({ PUBLIC_URL: 'https://tracker.example.com' });
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
  gina = await addUser(ctx, { email: 'gina@client.example', name: 'Gina Guest', role: 'guest' });
  await bob.client.post('/api/projects', { key: 'WEB', name: 'Website' });
  await bob.client.post('/api/projects', { key: 'CLI', name: 'Client portal', visibility: 'private' });
  await bob.client.post('/api/projects', { key: 'OPS', name: 'Operations', visibility: 'private' });
  await bob.client.post('/api/issues', { projectKey: 'WEB', type: 'epic', title: 'Secret web epic' });
  await bob.client.post('/api/issues', { projectKey: 'WEB', title: 'Secret web task', labels: ['webonly'] });
  await bob.client.post('/api/issues', { projectKey: 'OPS', title: 'Secret ops task' });
  await bob.client.post('/api/issues', { projectKey: 'CLI', type: 'epic', title: 'Portal epic' });
  await bob.client.post('/api/issues', { projectKey: 'CLI', title: 'Portal task', parentKey: 'CLI-1', labels: ['portal'] });
  await member(gina, 'CLI', 'guest-comment');
});

const member = (who, key, role) => bob.client.put(`/api/projects/${key}/members/${who.id}`, role ? { role } : {});
const keys = (r) => r.body.issues.map((i) => i.key).sort();

/** Session cookie of a test client (for raw uploads). */
async function cookieOf(who) {
  let cookie = '';
  const orig = ctx.app.request.bind(ctx.app);
  ctx.app.request = (path, init, env) => {
    cookie = init.headers.cookie;
    return orig(path, init, env);
  };
  await who.client.get('/api/me');
  ctx.app.request = orig;
  return cookie;
}
async function upload(who, key, query = '') {
  const form = new FormData();
  form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'notes.txt');
  const res = await ctx.app.request(
    `/api/issues/${key}/attachments${query}`,
    {
      method: 'POST',
      headers: { cookie: await cookieOf(who), 'x-requested-with': 'opentrack' },
      body: form,
    },
    ctx.env,
  );
  return { status: res.status, body: await res.json() };
}

describe('guest visibility', () => {
  it('sees only projects they are a member of, never open ones', async () => {
    const me = (await gina.client.get('/api/me')).body;
    expect(me.user.role).toBe('guest');
    expect(me.guest).toBe(true);
    expect(me.canCreateProject).toBe(false);
    expect((await gina.client.get('/api/projects')).body.projects.map((p) => p.key)).toEqual(['CLI']);
    expect((await gina.client.get('/api/projects/WEB')).status).toBe(404);
    expect((await gina.client.get('/api/projects/OPS')).status).toBe(404);
    const cli = (await gina.client.get('/api/projects/CLI')).body.project;
    expect(cli).toMatchObject({
      myRole: 'guest-comment',
      guest: true,
      canEdit: false,
      canAdmin: false,
      canCreate: false,
      canComment: true,
      canSprints: false,
    });
    expect((await gina.client.get('/api/issues/WEB-1')).status).toBe(404);
    expect((await gina.client.get('/api/issues/CLI-2')).status).toBe(200);
    // a member still sees the open project
    expect((await carol.client.get('/api/projects')).body.projects.map((p) => p.key)).toEqual(['WEB']);
  });

  it('search, board, backlog, labels, CSV and dashboard are limited to member projects', async () => {
    expect(keys(await gina.client.get('/api/issues'))).toEqual(['CLI-1', 'CLI-2']);
    expect((await gina.client.get('/api/issues?q=Secret')).body.total).toBe(0);
    expect((await gina.client.get('/api/issues?project=WEB')).body.total).toBe(0);
    expect(keys(await gina.client.get('/api/issues?project=CLI&sprint=open&sort=rank'))).toEqual(['CLI-1', 'CLI-2']);
    expect((await gina.client.get('/api/labels')).body.labels).toEqual(['portal']);
    const csv = (await gina.client.get('/api/issues.csv')).body;
    expect(csv).toContain('CLI-2');
    expect(csv).not.toContain('WEB-');
    await bob.client.patch('/api/issues/WEB-2', { assigneeId: carol.id });
    await bob.client.patch('/api/issues/CLI-2', { assigneeId: gina.id });
    const dash = (await gina.client.get('/api/dashboard')).body;
    expect(dash.assigned.map((i) => i.key)).toEqual(['CLI-2']);
    expect(dash.watching.every((i) => i.projectKey === 'CLI')).toBe(true);
  });

  it('reports (standard and custom), roadmap, timesheet, activity, digest and feeds', async () => {
    // standard project reports
    expect((await gina.client.get('/api/projects/WEB/reports')).status).toBe(404);
    expect((await gina.client.get('/api/projects/CLI/reports')).status).toBe(200);
    // custom report data across all projects
    const r = await gina.client.post('/api/report-data', { source: { query: {} }, kind: 'breakdown', options: { groupBy: 'project' } });
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2);
    expect(JSON.stringify(r.body)).not.toMatch(/WEB|OPS|Website|Operations/);
    // every standard report runs for all projects without leaking others
    for (const s of STANDARD_REPORTS) {
      const res = await gina.client.post('/api/report-data', standardDefinition(s, ''));
      expect(res.status, s.id).toBe(200);
      expect(JSON.stringify(res.body), s.id).not.toMatch(/WEB-|OPS-|Secret/);
    }
    // roadmap
    const road = (await gina.client.get('/api/roadmap')).body;
    expect(road.epics.map((e) => e.key)).toEqual(['CLI-1']);
    expect(road.projects.map((p) => p.key)).toEqual(['CLI']);
    expect((await gina.client.get('/api/roadmap?project=WEB')).status).toBe(404);
    // timesheet: own only, never the team or someone else
    await bob.client.post('/api/issues/WEB-2/worklogs', { hours: 2 });
    await bob.client.post('/api/issues/CLI-2/worklogs', { hours: 1 });
    expect((await gina.client.get('/api/timesheet?user=team')).status).toBe(403);
    expect((await gina.client.get(`/api/timesheet?user=${bob.id}`)).status).toBe(403);
    expect((await gina.client.get('/api/timesheet')).body.total).toBe(0);
    // activity
    const act = (await gina.client.get('/api/activity')).body.items;
    expect(act.length).toBeGreaterThan(0);
    expect(act.every((a) => a.issue.key.startsWith('CLI-'))).toBe(true);
    // digest
    expect((await gina.client.get('/api/digest')).status).toBe(200);
    // Google Sheets feed runs as the guest
    const feed = await gina.client.post('/api/feeds', { name: 'All', query: {} });
    expect(feed.status).toBe(201);
    const res = await ctx.app.request(new URL(feed.body.url).pathname, {}, ctx.env);
    const text = await res.text();
    expect(text).toContain('CLI-2');
    expect(text).not.toMatch(/WEB-|OPS-/);
  });

  it('people picker lists only members of their projects', async () => {
    const all = (await gina.client.get('/api/users')).body.users.map((u) => u.name).sort();
    expect(all).toEqual(['Bob', 'Gina Guest']);
    // members still see everyone, with the guest flag
    const seen = (await carol.client.get('/api/users')).body.users;
    expect(seen.map((u) => u.name)).toContain('Gina Guest');
    expect(seen.find((u) => u.name === 'Gina Guest').guest).toBe(true);
  });

  it('no AI connectors, API tokens, admin pages, projects, Trash or shared reports and filters', async () => {
    expect((await gina.client.post('/api/me/tokens', { name: 'x' })).status).toBe(403);
    expect((await gina.client.get('/api/me/tokens')).status).toBe(403);
    expect((await gina.client.get('/api/me/connected-apps')).status).toBe(403);
    expect((await gina.client.get('/api/admin/users')).status).toBe(403);
    expect((await gina.client.post('/api/projects', { key: 'GST', name: 'Mine' })).status).toBe(403);
    expect((await gina.client.get('/api/trash')).body.items).toEqual([]);
    // shared filters and reports of others stay hidden; guests cannot share
    await bob.client.post('/api/filters', { name: 'Team filter', query: { project: 'WEB' }, shared: true });
    await bob.client.post('/api/saved-reports', {
      name: 'Team report',
      source: { query: {} },
      kind: 'breakdown',
      options: { groupBy: 'status' },
      visibility: 'shared',
    });
    expect((await gina.client.get('/api/filters')).body.filters).toEqual([]);
    expect((await gina.client.get('/api/saved-reports')).body.reports).toEqual([]);
    expect(
      (
        await gina.client.post('/api/saved-reports', {
          name: 'Mine',
          source: { query: {} },
          kind: 'breakdown',
          options: { groupBy: 'status' },
          visibility: 'shared',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await gina.client.post('/api/saved-reports', {
          name: 'Mine',
          source: { query: {} },
          kind: 'breakdown',
          options: { groupBy: 'status' },
        })
      ).status,
    ).toBe(201);
    expect((await gina.client.post('/api/dashboards', { name: 'D', visibility: 'shared' })).status).toBe(403);
  });

  it('MCP and API tokens stop working when someone becomes a guest', async () => {
    const t = await carol.client.post('/api/me/tokens', { name: 'Claude' });
    expect(t.status).toBe(201);
    const call = (path) => ctx.app.request(path, { headers: { authorization: `Bearer ${t.body.token}` } }, ctx.env);
    expect((await call('/api/me')).status).toBe(200);
    await member(carol, 'CLI', 'member');
    expect((await ctx.admin.patch(`/api/admin/users/${carol.id}`, { role: 'guest' })).status).toBe(200);
    expect((await call('/api/me')).status).toBe(401);
    const mcp = await ctx.app.request(
      'http://t.example/mcp',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${t.body.token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      },
      ctx.env,
    );
    expect(mcp.status).toBe(401);
    // project role moved to a guest level, and back
    let m = (await bob.client.get('/api/projects/CLI')).body.project.members.find((x) => x.userId === carol.id);
    expect(m).toMatchObject({ role: 'guest-edit', guest: true });
    await ctx.admin.patch(`/api/admin/users/${carol.id}`, { role: 'member' });
    m = (await bob.client.get('/api/projects/CLI')).body.project.members.find((x) => x.userId === carol.id);
    expect(m.role).toBe('member');
    // the old token stays revoked
    expect((await call('/api/me')).status).toBe(401);
  });

  it('OAuth consent (AI connectors) refuses guests', async () => {
    const O = 'http://t.example';
    const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
    const reg = await ctx.app.request(
      `${O}/oauth/register`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT] }),
      },
      ctx.env,
    );
    const client = await reg.json();
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      code_challenge: 'x'.repeat(43),
      code_challenge_method: 'S256',
      state: 's',
      resource: 'https://tracker.example.com/mcp',
    }).toString();
    const asGuest = await ctx.app.request(`${O}/oauth/authorize?${q}`, { headers: { cookie: await cookieOf(gina) } }, ctx.env);
    expect(asGuest.status, asGuest.headers.get('location')).toBe(403);
    expect(await asGuest.text()).toContain('Guest accounts cannot connect AI apps');
    const asMember = await ctx.app.request(`${O}/oauth/authorize?${q}`, { headers: { cookie: await cookieOf(carol) } }, ctx.env);
    expect(asMember.status).toBe(200);
  });
});

describe('guest levels', () => {
  it('admins create guests, also from CSV; guest levels only for guests', async () => {
    const r = await ctx.admin.post('/api/admin/users/bulk', { users: [{ email: 'c1@client.example', name: 'C1', role: 'guest' }] });
    expect(r.body.results[0]).toMatchObject({ ok: true, user: { role: 'guest' } });
    expect((await bob.client.put(`/api/projects/CLI/members/${gina.id}`, { role: 'member' })).status).toBe(400);
    expect((await bob.client.put(`/api/projects/CLI/members/${carol.id}`, { role: 'guest-view' })).status).toBe(400);
    // a guest added without a role is read only
    const c1 = r.body.results[0].user.id;
    const d = await bob.client.put(`/api/projects/CLI/members/${c1}`, {});
    expect(d.body.members.find((m) => m.userId === c1).role).toBe('guest-view');
  });

  it('guest-view: read only', async () => {
    await member(gina, 'CLI', 'guest-view');
    expect((await gina.client.get('/api/issues/CLI-2')).body.issue).toMatchObject({
      canEdit: false,
      canComment: false,
      canWatch: false,
      canDelete: false,
    });
    expect((await gina.client.post('/api/issues/CLI-2/comments', { body: 'hi' })).status).toBe(403);
    expect((await gina.client.post('/api/issues/CLI-2/watch')).status).toBe(403);
    expect((await gina.client.post('/api/issues', { projectKey: 'CLI', title: 'x' })).status).toBe(403);
    expect((await gina.client.patch('/api/issues/CLI-2', { title: 'x' })).status).toBe(403);
    expect((await upload(gina, 'CLI-2')).status).toBe(403);
    const bulk = await gina.client.post('/api/issues/bulk', { keys: ['CLI-2'], action: 'watch' });
    expect(bulk.body.results[0].ok).toBe(false);
  });

  it('guest-comment: comment, add files to comments, watch; nothing else', async () => {
    const c = await gina.client.post('/api/issues/CLI-2/comments', { body: 'Looks good' });
    expect(c.status).toBe(201);
    expect(c.body.comment.internal).toBe(false);
    expect((await gina.client.post('/api/issues/CLI-2/comments', { body: 'x', internal: true })).status).toBe(403);
    expect((await gina.client.patch(`/api/comments/${c.body.comment.id}`, { body: 'Edited' })).status).toBe(200);
    expect((await gina.client.post('/api/issues/CLI-2/watch')).status).toBe(200);
    expect((await upload(gina, 'CLI-2')).status).toBe(201);
    expect((await upload(gina, 'CLI-2', '?internal=1')).status).toBe(403);
    expect((await gina.client.patch('/api/issues/CLI-2', { title: 'x' })).status).toBe(403);
    expect((await gina.client.post('/api/issues', { projectKey: 'CLI', title: 'x' })).status).toBe(403);
    expect((await gina.client.post('/api/issues/CLI-2/worklogs', { hours: 1 })).status).toBe(403);
    expect((await gina.client.del('/api/issues/CLI-2')).status).toBe(403);
    expect((await gina.client.post('/api/issues/CLI-2/watchers', { userId: bob.id })).status).toBe(403);
  });

  it('guest-edit: create issues and edit their own; no deleting, sprints or settings', async () => {
    await member(gina, 'CLI', 'guest-edit');
    const mine = await gina.client.post('/api/issues', { projectKey: 'CLI', title: 'Please fix the logo', assigneeId: bob.id });
    expect(mine.status).toBe(201);
    const key = mine.body.issue.key;
    expect((await gina.client.patch(`/api/issues/${key}`, { title: 'Please fix the logo now', priority: 'high' })).status).toBe(200);
    const d = (await gina.client.get(`/api/issues/${key}`)).body.issue;
    expect(d).toMatchObject({ canEdit: true, canDelete: false, canSprints: false, canEditAny: false, guest: true });
    // someone else's issue
    expect((await gina.client.patch('/api/issues/CLI-2', { title: 'x' })).status).toBe(403);
    expect((await gina.client.get('/api/issues/CLI-2')).body.issue.canEdit).toBe(false);
    // no deleting, sprints, reporter changes or settings
    expect((await gina.client.del(`/api/issues/${key}`)).status).toBe(403);
    expect((await gina.client.patch(`/api/issues/${key}`, { reporterId: bob.id })).status).toBe(403);
    expect((await gina.client.post('/api/projects/CLI/sprints', { name: 'S1' })).status).toBe(403);
    const sprint = (await bob.client.post('/api/projects/CLI/sprints', { name: 'S1' })).body.sprint;
    expect((await gina.client.patch(`/api/issues/${key}`, { sprintId: sprint.id })).status).toBe(403);
    expect((await gina.client.post('/api/issues', { projectKey: 'CLI', title: 'y', sprintId: sprint.id })).status).toBe(403);
    expect((await gina.client.post(`/api/sprints/${sprint.id}/start`, {})).status).toBe(403);
    expect((await gina.client.patch('/api/projects/CLI', { name: 'x' })).status).toBe(403);
    expect((await gina.client.patch('/api/projects/CLI', { permissions: { delete: 'reporter' } })).status).toBe(403);
    expect((await gina.client.post('/api/projects/CLI/import', { rows: [{ title: 'a' }] })).status).toBe(403);
    expect(
      (
        await gina.client.post('/api/projects/CLI/recurring', {
          name: 'r',
          title: 't',
          schedule: { freq: 'daily' },
          startDate: '2026-11-01',
        })
      ).status,
    ).toBe(403);
    // bulk: own issue fine, others fail, delete always fails
    const bulk = await gina.client.post('/api/issues/bulk', { keys: [key, 'CLI-2'], changes: { priority: 'low' } });
    expect(bulk.body.results.map((x) => x.ok)).toEqual([true, false]);
    const bd = await gina.client.post('/api/issues/bulk', { keys: [key], action: 'delete' });
    expect(bd.body.results[0].ok).toBe(false);
  });

  it('a guest cannot be assigned, watch or be added as a watcher outside their projects', async () => {
    expect((await bob.client.patch('/api/issues/OPS-1', { assigneeId: gina.id })).status).toBe(400);
    expect((await bob.client.post('/api/issues', { projectKey: 'WEB', title: 'x', assigneeId: gina.id })).status).toBe(400);
    expect((await bob.client.post('/api/issues/WEB-2/watchers', { userId: gina.id })).status).toBe(400);
    expect((await bob.client.patch('/api/issues/CLI-2', { assigneeId: gina.id })).status).toBe(200);
    // a mention of a guest outside the project sends nothing
    await bob.client.post('/api/issues/WEB-2/comments', { body: `cc @[Gina Guest](user:${gina.id})` });
    const n = (await gina.client.get('/api/notifications')).body.notifications;
    expect(n.every((x) => x.issueKey === 'CLI-2')).toBe(true);
  });
});

describe('internal notes', () => {
  it('are hidden from guests everywhere, and still shown to members', async () => {
    await gina.client.post('/api/issues/CLI-2/watch');
    const pub = await bob.client.post('/api/issues/CLI-2/comments', { body: 'Shipping Friday' });
    const note = await bob.client.post('/api/issues/CLI-2/comments', {
      body: `Internal: margin is thin @[Gina Guest](user:${gina.id})`,
      internal: true,
    });
    expect(note.status).toBe(201);
    expect(note.body.comment.internal).toBe(true);
    const file = await upload(bob, 'CLI-2', '?internal=1');
    expect(file.status).toBe(201);
    expect(file.body.attachment.internal).toBe(true);

    // issue view
    const g = (await gina.client.get('/api/issues/CLI-2')).body.issue;
    expect(g.comments.map((x) => x.body)).toEqual(['Shipping Friday']);
    expect(g.attachments).toEqual([]);
    expect(g.history.some((h) => h.field === 'internal_attachment')).toBe(false);
    expect(JSON.stringify(g)).not.toContain('margin');
    const b = (await bob.client.get('/api/issues/CLI-2')).body.issue;
    expect(b.comments.map((x) => [x.body.slice(0, 8), x.internal])).toEqual([
      ['Shipping', false],
      ['Internal', true],
    ]);
    expect(b.attachments).toHaveLength(1);
    // the file and the comment by id
    expect((await gina.client.get(file.body.attachment.url)).status).toBe(404);
    expect((await gina.client.patch(`/api/comments/${note.body.comment.id}`, { body: 'x' })).status).toBe(404);
    expect((await gina.client.del(`/api/comments/${note.body.comment.id}`)).status).toBe(404);
    // activity
    const act = (await gina.client.get('/api/activity?project=CLI')).body.items;
    expect(JSON.stringify(act)).not.toContain('margin');
    expect(act.some((a) => a.field === 'internal_attachment')).toBe(false);
    expect(JSON.stringify((await bob.client.get('/api/activity?project=CLI')).body.items)).toContain('margin');
    // notifications: the public comment only
    const n = (await gina.client.get('/api/notifications')).body.notifications;
    expect(n.filter((x) => x.type === 'comment' || x.type === 'mentioned')).toHaveLength(1);
    expect(JSON.stringify(n)).not.toContain('margin');
    expect(pub.status).toBe(201);
    // digest: watched issue counts one comment, not two
    await ctx.db.run('UPDATE comments SET created_at = ?', [new Date().toISOString()]);
    const digest = (await gina.client.get('/api/digest')).body;
    expect(digest.watched.find((w) => w.key === 'CLI-2')?.comments).toBe(1);
    expect(digest.mentions).toEqual([]);
    expect((await bob.client.get('/api/digest')).status).toBe(200);
  });

  it('members can turn a comment into an internal note; guests cannot', async () => {
    const c = await bob.client.post('/api/issues/CLI-2/comments', { body: 'Budget is 10k' });
    expect((await bob.client.patch(`/api/comments/${c.body.comment.id}`, { body: 'Budget is 10k', internal: true })).status).toBe(200);
    expect((await gina.client.get('/api/issues/CLI-2')).body.issue.comments).toEqual([]);
    const own = await gina.client.post('/api/issues/CLI-2/comments', { body: 'mine' });
    expect((await gina.client.patch(`/api/comments/${own.body.comment.id}`, { body: 'mine', internal: true })).status).toBe(403);
  });
});
