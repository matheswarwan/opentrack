import { describe, it, expect } from 'vitest';
import { withAdmin, addUser } from './helpers.js';

describe('estimates vs actuals', () => {
  it('rolls estimates and logged hours up to epics, sub-tasks included', async () => {
    const ctx = await withAdmin();
    const bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
    const c = bob.client;
    await c.post('/api/projects', { key: 'WEB', name: 'Website' });
    const epic = (await c.post('/api/issues', { projectKey: 'WEB', title: 'Launch', type: 'epic', estimateHours: 2 })).body.issue.key;
    const story = (
      await c.post('/api/issues', { projectKey: 'WEB', title: 'Story', type: 'story', parentKey: epic, estimateHours: 8, storyPoints: 5 })
    ).body.issue.key;
    const sub = (await c.post('/api/issues', { projectKey: 'WEB', title: 'Sub', type: 'subtask', parentKey: story, estimateHours: 3 })).body
      .issue.key;
    const loose = (await c.post('/api/issues', { projectKey: 'WEB', title: 'Loose', estimateHours: 1 })).body.issue.key;
    await c.post(`/api/issues/${story}/worklogs`, { hours: 6 });
    await c.post(`/api/issues/${sub}/worklogs`, { hours: 5 });
    await c.post(`/api/issues/${loose}/worklogs`, { hours: 2 });
    const done = (await c.get('/api/projects/WEB')).body.project.statuses.find((s) => s.category === 'done');
    await c.patch(`/api/issues/${story}`, { statusId: done.id });
    const r = (await c.get('/api/projects/WEB/estimates')).body;
    const e = r.rows.find((x) => x.key === epic);
    expect(e).toMatchObject({ estimate: 13, logged: 11, remaining: 2, variance: -2, issues: 2, doneIssues: 1, points: 5, donePoints: 5 });
    expect(r.rows.find((x) => x.key === null)).toMatchObject({ estimate: 1, logged: 2, variance: 1, variancePct: 100 });
    expect(r.totals).toMatchObject({ estimate: 14, logged: 13 });
    await c.del(`/api/issues/${loose}`);
    expect((await c.get('/api/projects/WEB/estimates')).body.totals.logged).toBe(11);
  });
});
