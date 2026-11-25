// Project permissions (Project settings > Permissions): who can delete issues, manage sprints, create issues
// and comment. Enforced in server/lib/access.js (projectAccess / loadIssue).
import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser } from './helpers.js';

let ctx, bob, carol, gina;
// WEB is Bob's (project admin); Carol is a member; Gina a guest who can create and edit her own issues.
beforeEach(async () => {
  ctx = await withAdmin();
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
  gina = await addUser(ctx, { email: 'gina@client.example', name: 'Gina', role: 'guest' });
  await bob.client.post('/api/projects', { key: 'WEB', name: 'Website', visibility: 'private' });
  await bob.client.put(`/api/projects/WEB/members/${carol.id}`, { role: 'member' });
  await bob.client.put(`/api/projects/WEB/members/${gina.id}`, { role: 'guest-edit' });
});

const setPerms = (permissions, who = bob) => who.client.patch('/api/projects/WEB', { permissions });
const create = (who, data = {}) => who.client.post('/api/issues', { projectKey: 'WEB', title: 'Task', ...data });

describe('permission settings', () => {
  it('defaults keep the old behaviour and are shown on the project', async () => {
    const p = (await carol.client.get('/api/projects/WEB')).body.project;
    expect(p.permissions).toEqual({ delete: 'reporter', sprints: 'members', create: 'members', comment: 'all' });
    expect(p).toMatchObject({ canCreate: true, canSprints: true, canComment: true, canEdit: true, canAdmin: false });
    const k = (await create(carol)).body.issue.key;
    expect((await carol.client.get(`/api/issues/${k}`)).body.issue.canDelete).toBe(true);
    expect((await carol.client.del(`/api/issues/${k}`)).status).toBe(200);
    expect((await carol.client.post('/api/projects/WEB/sprints', { name: 'S1' })).status).toBe(201);
  });

  it('only project admins change them, with valid values', async () => {
    expect((await setPerms({ delete: 'admins' }, carol)).status).toBe(403);
    expect((await setPerms({ delete: 'nobody' })).status).toBe(400);
    expect((await setPerms({ colour: 'red' })).status).toBe(400);
    const r = await setPerms({ delete: 'admins', sprints: 'admins', create: 'admins', comment: 'members' });
    expect(r.status).toBe(200);
    expect(r.body.project.permissions).toEqual({ delete: 'admins', sprints: 'admins', create: 'admins', comment: 'members' });
    // workspace admins can too
    expect((await setPerms({ delete: 'reporter' }, { client: ctx.admin })).status).toBe(200);
  });
});

describe('who can delete issues', () => {
  it('project admins only: members cannot delete their own, also in bulk', async () => {
    const mine = (await create(carol)).body.issue.key;
    const other = (await create(carol)).body.issue.key;
    await setPerms({ delete: 'admins' });
    expect((await carol.client.get(`/api/issues/${mine}`)).body.issue.canDelete).toBe(false);
    const r = await carol.client.del(`/api/issues/${mine}`);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('Only project admins can delete issues in this project');
    const bulk = await carol.client.post('/api/issues/bulk', { keys: [mine, other], action: 'delete' });
    expect(bulk.body.results.every((x) => !x.ok)).toBe(true);
    // the project admin and a workspace admin still can
    expect((await bob.client.post('/api/issues/bulk', { keys: [mine], action: 'delete' })).body.results[0].ok).toBe(true);
    expect((await ctx.admin.del(`/api/issues/${other}`)).status).toBe(200);
  });

  it('reporter (default): members delete only their own', async () => {
    const bobs = (await create(bob)).body.issue.key;
    expect((await carol.client.del(`/api/issues/${bobs}`)).status).toBe(403);
  });
});

describe('who can manage sprints', () => {
  it('project admins only: members cannot create, start, complete or delete sprints or move issues between them', async () => {
    const s1 = (await bob.client.post('/api/projects/WEB/sprints', { name: 'S1' })).body.sprint;
    const k = (await create(carol)).body.issue.key;
    await setPerms({ sprints: 'admins' });
    expect((await carol.client.get('/api/projects/WEB')).body.project.canSprints).toBe(false);
    const made = await carol.client.post('/api/projects/WEB/sprints', { name: 'S2' });
    expect(made.status).toBe(403);
    expect(made.body.error).toBe('Only project admins can manage sprints in this project');
    expect((await carol.client.patch(`/api/sprints/${s1.id}`, { name: 'x' })).status).toBe(403);
    expect((await carol.client.post(`/api/sprints/${s1.id}/start`, {})).status).toBe(403);
    expect((await carol.client.del(`/api/sprints/${s1.id}`)).status).toBe(403);
    expect((await carol.client.patch(`/api/issues/${k}`, { sprintId: s1.id })).status).toBe(403);
    expect((await carol.client.post(`/api/issues/${k}/move`, { sprintId: s1.id })).status).toBe(403);
    expect((await create(carol, { sprintId: s1.id })).status).toBe(403);
    const bulk = await carol.client.post('/api/issues/bulk', { keys: [k], changes: { sprintId: s1.id } });
    expect(bulk.body.results[0]).toMatchObject({ ok: false, error: 'Only project admins can manage sprints in this project' });
    expect((await carol.client.post('/api/projects/WEB/import', { rows: [{ title: 'a', sprint: 'S1' }] })).status).toBe(403);
    // other edits still work
    expect((await carol.client.patch(`/api/issues/${k}`, { title: 'Renamed' })).status).toBe(200);
    // the project admin can
    expect((await bob.client.patch(`/api/issues/${k}`, { sprintId: s1.id })).status).toBe(200);
    expect((await bob.client.post(`/api/sprints/${s1.id}/start`, {})).status).toBe(200);
    expect((await ctx.admin.post(`/api/sprints/${s1.id}/complete`, {})).status).toBe(200);
  });
});

describe('who can create issues', () => {
  it('project admins only: members and guest editors cannot create, import or add recurring rules', async () => {
    await setPerms({ create: 'admins' });
    expect((await carol.client.get('/api/projects/WEB')).body.project.canCreate).toBe(false);
    const r = await create(carol);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('Only project admins can create issues in this project');
    expect((await create(gina)).status).toBe(403);
    expect((await carol.client.post('/api/projects/WEB/import', { rows: [{ title: 'a' }] })).status).toBe(403);
    expect(
      (
        await carol.client.post('/api/projects/WEB/recurring', {
          name: 'r',
          title: 't',
          schedule: { freq: 'daily' },
          startDate: '2026-11-01',
        })
      ).status,
    ).toBe(403);
    // members can still edit existing issues
    const k = (await create(bob)).body.issue.key;
    expect(k).toBe('WEB-1');
    expect((await carol.client.patch(`/api/issues/${k}`, { priority: 'high' })).status).toBe(200);
    expect((await create({ client: ctx.admin })).status).toBe(201);
    // members default: guests with guest-edit can create
    await setPerms({ create: 'members' });
    expect((await create(gina)).status).toBe(201);
  });
});

describe('who can comment', () => {
  it('team members only: guests cannot comment, members can', async () => {
    const k = (await create(bob)).body.issue.key;
    expect((await gina.client.post(`/api/issues/${k}/comments`, { body: 'hello' })).status).toBe(201);
    await setPerms({ comment: 'members' });
    const r = await gina.client.post(`/api/issues/${k}/comments`, { body: 'hello again' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('Only team members can comment in this project');
    expect((await gina.client.get(`/api/issues/${k}`)).body.issue.canComment).toBe(false);
    expect((await carol.client.post(`/api/issues/${k}/comments`, { body: 'fine' })).status).toBe(201);
    expect((await ctx.admin.post(`/api/issues/${k}/comments`, { body: 'fine' })).status).toBe(201);
  });

  it('viewers still cannot comment, whatever the setting', async () => {
    const dave = await addUser(ctx, { email: 'dave@example.com', name: 'Dave' });
    await bob.client.put(`/api/projects/WEB/members/${dave.id}`, { role: 'viewer' });
    const k = (await create(bob)).body.issue.key;
    expect((await dave.client.post(`/api/issues/${k}/comments`, { body: 'x' })).status).toBe(403);
  });
});

describe('members and admins are unaffected by guests', () => {
  it('an open project is still edited by every member, and admins see every project', async () => {
    await bob.client.post('/api/projects', { key: 'OPN', name: 'Open' });
    const dave = await addUser(ctx, { email: 'dave@example.com', name: 'Dave' });
    const k = (await dave.client.post('/api/issues', { projectKey: 'OPN', title: 'x' })).body.issue.key;
    expect((await dave.client.patch(`/api/issues/${k}`, { title: 'y' })).status).toBe(200);
    expect((await dave.client.post(`/api/issues/${k}/comments`, { body: 'c' })).status).toBe(201);
    expect((await ctx.admin.get('/api/projects')).body.projects.map((p) => p.key).sort()).toEqual(['OPN', 'WEB']);
    expect((await gina.client.get('/api/projects')).body.projects.map((p) => p.key)).toEqual(['WEB']);
  });
});
