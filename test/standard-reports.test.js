import { describe, it, expect } from 'vitest';
import { withAdmin, addUser } from './helpers.js';
import { STANDARD_REPORTS, standardDefinition } from '../src/standardReports.js';

describe('standard reports', () => {
  it('every standard report runs for all projects and for one project', async () => {
    const ctx = await withAdmin();
    const bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
    await bob.client.post('/api/projects', { key: 'WEB', name: 'Website' });
    const epic = (await bob.client.post('/api/issues', { projectKey: 'WEB', title: 'Epic', type: 'epic' })).body.issue.key;
    for (const [i, t] of ['bug', 'story', 'task'].entries()) {
      const k = (
        await bob.client.post('/api/issues', {
          projectKey: 'WEB',
          title: `${t} ${i}`,
          type: t,
          parentKey: epic,
          labels: ['x'],
          storyPoints: i + 1,
          estimateHours: 2,
          dueDate: i === 0 ? '2020-01-01' : null,
          assigneeId: i ? bob.id : null,
        })
      ).body.issue.key;
      await bob.client.post(`/api/issues/${k}/worklogs`, { hours: 1 });
    }
    expect(STANDARD_REPORTS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(STANDARD_REPORTS.map((r) => r.id)).size).toBe(STANDARD_REPORTS.length);
    for (const r of STANDARD_REPORTS) {
      for (const key of ['', 'WEB']) {
        const res = await bob.client.post('/api/report-data', standardDefinition(r, key));
        expect(res.status, `${r.id} ${key}: ${JSON.stringify(res.body)}`).toBe(200);
      }
    }
    const overdue = await bob.client.post(
      '/api/report-data',
      standardDefinition(
        STANDARD_REPORTS.find((r) => r.id === 'overdue'),
        'WEB',
      ),
    );
    expect(overdue.body.issues.map((i) => i.title)).toEqual(['bug 0']);
    const logged = await bob.client.post(
      '/api/report-data',
      standardDefinition(
        STANDARD_REPORTS.find((r) => r.id === 'logged-by-epic'),
        '',
      ),
    );
    expect(logged.body.groups.reduce((s, g) => s + g.value, 0)).toBe(3);
  });
});
