import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser } from './helpers.js';
import { runDueJobs } from '../server/lib/jobs.js';

let ctx, bob;
beforeEach(async () => {
  ctx = await withAdmin();
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  await ctx.admin.post('/api/projects', { key: 'WEB', name: 'Website' });
  await ctx.admin.put(`/api/projects/WEB/members/${bob.id}`, { role: 'member' });
  await ctx.admin.post('/api/issues', { projectKey: 'WEB', title: 'First' });
  await ctx.admin.post('/api/issues', { projectKey: 'WEB', title: 'Child', type: 'subtask', parentKey: 'WEB-1' });
  await ctx.admin.post('/api/issues/WEB-1/comments', { body: 'hello' });
  await ctx.admin.post('/api/projects', { key: 'APP', name: 'App' });
  await ctx.admin.post('/api/issues', { projectKey: 'APP', title: 'Other project' });
});

describe('deleting a project (admins)', () => {
  it('needs an admin and the typed key, then hides the project everywhere', async () => {
    // members cannot delete
    expect((await bob.client.del('/api/projects/WEB')).status).toBe(403);
    // the key must be typed
    expect((await ctx.admin.del('/api/projects/WEB')).status).toBe(400);
    const r = await deleteProject('WEB', 'web');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ key: 'WEB', issues: 2 });
    // gone from lists, search, project pages and its issues, for admins and members
    for (const c of [ctx.admin, bob.client]) {
      expect((await c.get('/api/projects')).body.projects.map((p) => p.key)).not.toContain('WEB');
      expect((await c.get('/api/projects/WEB')).status).toBe(404);
      expect((await c.get('/api/issues/WEB-1')).status).toBe(404);
      expect((await c.get('/api/issues?q=First')).body.issues.map((i) => i.key)).not.toContain('WEB-1');
    }
    expect((await ctx.admin.get('/api/issues?q=Other')).body.issues.map((i) => i.key)).toContain('APP-1');
    // the key stays taken while it is in the Trash
    const again = await ctx.admin.post('/api/projects', { key: 'WEB', name: 'New web' });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/Trash/);
    // listed in the project Trash, admins only
    const trash = (await ctx.admin.get('/api/project-trash')).body;
    expect(trash.projects).toMatchObject([{ key: 'WEB', name: 'Website', issues: 2, deletedBy: 'Ada Admin' }]);
    expect((await bob.client.get('/api/project-trash')).status).toBe(403);
    expect((await ctx.admin.get('/api/admin/audit?action=project.trashed')).body.entries).toMatchObject([
      { action: 'project.trashed', details: { key: 'WEB', issues: 2 } },
    ]);
  });

  it('restores with everything and its archived flag', async () => {
    await ctx.admin.patch('/api/projects/WEB', { archived: true });
    await deleteProject('WEB', 'WEB');
    expect((await ctx.admin.post('/api/project-trash/WEB/restore')).status).toBe(200);
    const p = (await ctx.admin.get('/api/projects/WEB')).body.project;
    expect(p.archived).toBe(true);
    await ctx.admin.patch('/api/projects/WEB', { archived: false });
    await deleteProject('WEB', 'WEB');
    await ctx.admin.post('/api/project-trash/WEB/restore');
    expect((await ctx.admin.get('/api/projects/WEB')).body.project.archived).toBe(false);
    expect((await bob.client.get('/api/issues/WEB-1')).status).toBe(200);
  });

  it('deletes forever (typed key) or after trashDays, with everything in it', async () => {
    expect((await purge('WEB', 'WEB')).status).toBe(400); // not in the Trash yet
    await deleteProject('WEB', 'WEB');
    expect((await purge('WEB', 'nope')).status).toBe(400);
    const r = await purge('WEB', 'WEB');
    expect(r.status).toBe(200);
    for (const t of ['projects', 'issues', 'comments', 'statuses']) {
      const n = (
        await ctx.db.get(
          `SELECT CAST(COUNT(*) AS INTEGER) AS n FROM ${t} WHERE ${t === 'projects' ? "key = 'WEB'" : t === 'comments' ? 'issue_id NOT IN (SELECT id FROM issues)' : t === 'issues' ? "key LIKE 'WEB-%'" : 'project_id NOT IN (SELECT id FROM projects)'}`,
        )
      ).n;
      expect([t, n]).toEqual([t, 0]);
    }
    expect((await ctx.admin.get('/api/issues/APP-1')).status).toBe(200);
    // the key can be used again
    expect((await ctx.admin.post('/api/projects', { key: 'WEB', name: 'Fresh' })).status).toBeLessThan(300);

    // the purge job removes a project after trashDays
    await deleteProject('APP', 'APP');
    await ctx.db.run(`UPDATE projects SET deleted_at = '2000-01-01T00:00:00.000Z' WHERE key = 'APP'`);
    const job = await runDueJobs({ env: ctx.env, req: { url: 'https://t.example/api/x' } }, { force: 'trash_purge' });
    expect(job.status).toBe('done');
    expect(job.result.projects).toBe(1);
    expect(await ctx.db.get(`SELECT id FROM projects WHERE key = 'APP'`)).toBeFalsy();
  });
});

async function deleteProject(key, confirm) {
  return raw('DELETE', `/api/projects/${key}`, { confirm });
}
async function purge(key, confirm) {
  return raw('DELETE', `/api/project-trash/${key}`, { confirm });
}
// the test client's del() sends no body; these calls need one
async function raw(method, path, body) {
  return ctx.admin[method === 'DELETE' ? 'delBody' : 'post'](path, body);
}
