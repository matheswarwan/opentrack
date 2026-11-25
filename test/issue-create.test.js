// server/lib/issues/create.js: number and rank allocation, the default status, the insert column list.
import { describe, it, expect } from 'vitest';
import { withAdmin } from './helpers.js';
import { allocate, firstStatus, ISSUE_COLUMNS, ISSUE_INSERT_SQL } from '../server/lib/issues/create.js';
import { RANK_STEP } from '../server/lib/issues/model.js';

describe('issue creation helpers', () => {
  it('reserves numbers and ranks after the existing issues', async () => {
    const ctx = await withAdmin();
    await ctx.admin.post('/api/projects', { key: 'WEB', name: 'Website' });
    const project = (await ctx.admin.get('/api/projects/WEB')).body.project;
    const one = await allocate(ctx.db, project);
    expect(one.first).toBe(1);
    expect([one.number(0), one.rank(0)]).toEqual([1, RANK_STEP]);
    const made = (await ctx.admin.post('/api/issues', { projectKey: 'WEB', title: 'Real' })).body.issue;
    expect(made.key).toBe('WEB-2'); // number 1 stays reserved
    const three = await allocate(ctx.db, project, 3);
    expect([0, 1, 2].map(three.number)).toEqual([3, 4, 5]);
    expect([0, 1, 2].map(three.rank)).toEqual([made.rank + RANK_STEP, made.rank + 2 * RANK_STEP, made.rank + 3 * RANK_STEP]);
    expect((await ctx.admin.post('/api/issues', { projectKey: 'WEB', title: 'Next' })).body.issue.key).toBe('WEB-6');
  });

  it('gives the first status of a project, and nothing for a project without statuses', async () => {
    const ctx = await withAdmin();
    await ctx.admin.post('/api/projects', { key: 'WEB', name: 'Website' });
    const project = (await ctx.admin.get('/api/projects/WEB')).body.project;
    expect(await firstStatus(ctx.db, project.id)).toEqual({ id: project.statuses[0].id, category: project.statuses[0].category });
    expect(await firstStatus(ctx.db, 'no-such-project')).toBeFalsy();
    // a status of another project is refused on create
    await ctx.admin.post('/api/projects', { key: 'OPS', name: 'Ops' });
    const r = await ctx.admin.post('/api/issues', { projectKey: 'OPS', title: 'x', statusId: project.statuses[0].id });
    expect([r.status, r.body.error]).toEqual([400, 'Status not found']);
  });

  it('has one placeholder per column', () => {
    expect(ISSUE_INSERT_SQL.match(/\?/g)).toHaveLength(ISSUE_COLUMNS.length);
  });
});
