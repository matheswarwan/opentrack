import { describe, it, expect } from 'vitest';
import { withAdmin, addUser } from './helpers.js';

describe('timesheet', () => {
  it('sums hours per day, issue and project; admins see the team', async () => {
    const ctx = await withAdmin();
    const bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
    const carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
    await bob.client.post('/api/projects', { key: 'WEB', name: 'Website' });
    const a = (await bob.client.post('/api/issues', { projectKey: 'WEB', title: 'A' })).body.issue.key;
    const b = (await bob.client.post('/api/issues', { projectKey: 'WEB', title: 'B' })).body.issue.key;
    await bob.client.post(`/api/issues/${a}/worklogs`, { hours: 2, workDate: '2026-11-16' });
    await bob.client.post(`/api/issues/${a}/worklogs`, { hours: 1.5, workDate: '2026-11-17' });
    await bob.client.post(`/api/issues/${b}/worklogs`, { hours: 3, workDate: '2026-11-17' });
    await carol.client.post(`/api/issues/${a}/worklogs`, { hours: 4, workDate: '2026-11-17' });
    await bob.client.post(`/api/issues/${b}/worklogs`, { hours: 8, workDate: '2026-11-30' });
    const t = (await bob.client.get('/api/timesheet?from=2026-11-16&to=2026-11-22')).body;
    expect(t.days).toHaveLength(7);
    expect(t.total).toBe(6.5);
    expect(t.perDay['2026-11-17']).toBe(4.5);
    expect(t.byIssue.find((i) => i.key === a)).toMatchObject({ total: 3.5 });
    expect(t.byProject).toEqual([{ key: 'WEB', name: 'Website', total: 6.5 }]);
    expect((await bob.client.get('/api/timesheet?user=team&from=2026-11-16&to=2026-11-22')).status).toBe(403);
    expect((await bob.client.get(`/api/timesheet?user=${carol.id}`)).status).toBe(403);
    const team = (await ctx.admin.get('/api/timesheet?user=team&from=2026-11-16&to=2026-11-22')).body;
    expect(team.total).toBe(10.5);
    expect(team.byUser.map((u) => [u.name, u.total]).sort()).toEqual([
      ['Bob', 6.5],
      ['Carol', 4],
    ]);
    expect((await bob.client.get('/api/timesheet?from=2026-11-20&to=2026-11-10')).status).toBe(400);
  });

  it('leaves out projects the viewer cannot see', async () => {
    const ctx = await withAdmin();
    const bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
    await bob.client.post('/api/projects', { key: 'SEC', name: 'Secret', visibility: 'private' });
    const k = (await bob.client.post('/api/issues', { projectKey: 'SEC', title: 'x' })).body.issue.key;
    await bob.client.post(`/api/issues/${k}/worklogs`, { hours: 2, workDate: '2026-11-16' });
    await bob.client.put(`/api/projects/SEC/members/${bob.id}`, { role: 'admin' });
    expect((await bob.client.get('/api/timesheet?from=2026-11-16&to=2026-11-16')).body.total).toBe(2);
    await ctx.admin.patch('/api/projects/SEC', { visibility: 'private' });
    // Bob removed from the private project no longer sees that time
    const me = (await ctx.admin.get('/api/me')).body.user.id;
    await ctx.admin.put(`/api/projects/SEC/members/${me}`, { role: 'admin' });
    await ctx.admin.del(`/api/projects/SEC/members/${bob.id}`);
    await ctx.admin.patch('/api/projects/SEC', { leadId: me });
    expect((await bob.client.get('/api/timesheet?from=2026-11-16&to=2026-11-16')).body.total).toBe(0);
  });
});
