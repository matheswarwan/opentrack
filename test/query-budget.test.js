// Counts database statements per request for the busiest endpoints. Cloudflare D1 on the free
// plan allows about 50 queries per Worker invocation; keep the main pages well under that.
import { describe, it, expect } from 'vitest';
import { withAdmin, addUser } from './helpers.js';

function countingDb(db) {
  let n = 0;
  const wrap =
    (fn) =>
    async (...a) => {
      n++;
      return fn(...a);
    };
  const counted = {
    ...db,
    all: wrap(db.all.bind(db)),
    get: wrap(db.get.bind(db)),
    run: wrap(db.run.bind(db)),
    batch: async (s) => {
      n += s.length;
      return db.batch(s);
    },
  };
  return {
    counted,
    reset: () => {
      n = 0;
    },
    get count() {
      return n;
    },
  };
}

describe('query budget per request', () => {
  it('keeps the main endpoints under 40 statements', async () => {
    const ctx = await withAdmin();
    const bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
    const c = bob.client;
    await c.post('/api/projects', { key: 'WEB', name: 'Website' });
    await c.post('/api/projects/WEB/fields', { name: 'Client', type: 'select', options: [{ name: 'A' }] });
    const epic = (await c.post('/api/issues', { projectKey: 'WEB', title: 'Epic', type: 'epic' })).body.issue.key;
    const keys = [];
    for (let i = 0; i < 40; i++)
      keys.push(
        (await c.post('/api/issues', { projectKey: 'WEB', title: `Issue ${i}`, parentKey: i % 2 ? epic : undefined, labels: ['a', 'b'] }))
          .body.issue.key,
      );
    await c.post(`/api/issues/${keys[1]}/links`, { type: 'blocks', targetKey: keys[2] });
    for (let i = 0; i < 5; i++) await c.post(`/api/issues/${keys[0]}/comments`, { body: `c${i}` });
    await c.post(`/api/issues/${keys[0]}/worklogs`, { hours: 1 });
    await c.put('/api/projects/WEB/budget', {
      kind: 'money',
      amount: 1000,
      lines: [{ targetType: 'epic', targetId: (await c.get(`/api/issues/${epic}`)).body.issue.id, hours: 5 }],
    });
    await c.post('/api/projects/WEB/budget/rates', { scope: 'role', role: 'admin', rate: 100 });
    for (let i = 0; i < 30; i++)
      await c.post('/api/projects/WEB/raid', {
        type: i % 2 ? 'risk' : 'decision',
        title: `Entry ${i}`,
        probability: 3,
        impact: 4,
        issueKeys: keys.slice(0, 3),
      });
    const raidId = (await c.get('/api/projects/WEB/raid')).body.entries[0].id;

    const meter = countingDb(ctx.env.db);
    ctx.env.db = meter.counted;
    const results = {};
    const measure = async (name, fn) => {
      meter.reset();
      const r = await fn();
      results[name] = meter.count;
      expect(r.status, name).toBeLessThan(300);
    };
    await measure('me', () => c.get('/api/me'));
    await measure('dashboard', () => c.get('/api/dashboard'));
    await measure('projects', () => c.get('/api/projects'));
    await measure('project', () => c.get('/api/projects/WEB'));
    await measure('board issues', () => c.get('/api/issues?project=WEB&sort=rank&limit=1000&noSubtasks=1'));
    await measure('issue detail', () => c.get(`/api/issues/${keys[0]}`));
    await measure('epic detail', () => c.get(`/api/issues/${epic}`));
    await measure('update status', async () => {
      const p = (await c.get('/api/projects/WEB')).body.project;
      meter.reset();
      return c.patch(`/api/issues/${keys[3]}`, { statusId: p.statuses[1].id });
    });
    await measure('create issue', () => c.post('/api/issues', { projectKey: 'WEB', title: 'New', labels: ['x'] }));
    await measure('comment', () => c.post(`/api/issues/${keys[0]}/comments`, { body: 'hi' }));
    await measure('activity', () => c.get('/api/activity?project=WEB'));
    await measure('project reports', () => c.get('/api/projects/WEB/reports'));
    await measure('roadmap', () => c.get('/api/roadmap?project=WEB'));
    await measure('timesheet', () => c.get('/api/timesheet'));
    await measure('budget', () => c.get('/api/projects/WEB/budget'));
    await measure('log work', () => c.post(`/api/issues/${keys[1]}/worklogs`, { hours: 2 }));
    await measure('raid list', () => c.get('/api/projects/WEB/raid'));
    await measure('raid entry', () => c.get(`/api/projects/WEB/raid/${raidId}`));
    await measure('create raid entry', () =>
      c.post('/api/projects/WEB/raid', {
        type: 'risk',
        title: 'New risk',
        probability: 5,
        impact: 5,
        ownerId: bob.id,
        issueKeys: keys.slice(0, 40),
      }),
    );
    await measure('edit raid entry', () =>
      c.patch(`/api/projects/WEB/raid/${raidId}`, {
        type: 'risk',
        title: 'Changed',
        description: 'x',
        probability: 2,
        impact: 2,
        mitigation: 'm',
        contingency: 'c',
        reviewDate: '2026-12-01',
        status: 'monitoring',
        issueKeys: keys.slice(5, 45),
      }),
    );
    await measure('calendar', () => c.get('/api/calendar?from=2026-11-01&to=2026-12-12&includeDone=1'));
    for (let i = 0; i < 10; i++) {
      // portfolio: 10 more projects; it aggregates with GROUP BY, never per project
      await c.post('/api/projects', { key: `PF${i}`, name: `Portfolio ${i}` });
      await c.post('/api/issues', { projectKey: `PF${i}`, title: 'Work' });
      await c.post(`/api/projects/PF${i}/releases`, { name: 'R1', releaseDate: '2026-12-01' });
    }
    await measure('portfolio', () => c.get('/api/portfolio'));
    // capacity: more people than one IN list holds (it aggregates per 80 people, never per person)
    const webId = (await c.get('/api/projects/WEB')).body.project.id;
    const t = new Date().toISOString();
    await ctx.env.db.batch(
      Array.from({ length: 90 }, (_, i) => [
        {
          sql: `INSERT INTO users (id, email, name, role, status, created_at, updated_at) VALUES (?, ?, ?, 'member', 'active', ?, ?)`,
          params: [`cap-${i}`, `p${i}@example.com`, `Person ${i}`, t, t],
        },
        {
          sql: `INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)`,
          params: [webId, `cap-${i}`, t],
        },
      ]).flat(),
    );
    await c.put('/api/capacity/people/me', { weeklyHours: 32 });
    await c.post('/api/capacity/people/me/time-off', { startDate: '2026-12-01', endDate: '2026-12-03' });
    await measure('capacity', () => c.get('/api/capacity'));
    await measure('capacity project', () => c.get('/api/capacity?project=WEB'));
    await measure('project capacity', () => c.get('/api/projects/WEB/capacity'));
    expect(results.portfolio, 'portfolio stays under 16 statements').toBeLessThan(16);
    expect(results.capacity, 'capacity stays under 16 statements with 92 people').toBeLessThan(16);
    const sprint = (await c.post('/api/projects/WEB/sprints', {})).body.sprint; // worst case: the draft reads the burndown
    await c.post(`/api/sprints/${sprint.id}/start`, {});
    await measure('sprint capacity', () => c.get('/api/projects/WEB/sprint-capacity'));
    let reportId;
    await measure('create status report', async () => {
      const r = await c.post('/api/projects/WEB/status-reports', {});
      reportId = r.body.report?.id;
      return r;
    });
    await measure('status report', () => c.get(`/api/projects/WEB/status-reports/${reportId}`));
    console.log('statements per request:', JSON.stringify(results));
    for (const [name, n] of Object.entries(results)) expect(n, `${name} used ${n}`).toBeLessThan(40);
  });
});
