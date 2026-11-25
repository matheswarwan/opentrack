import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser } from './helpers.js';

let ctx, bob, carol, dave;
beforeEach(async () => {
  ctx = await withAdmin();
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
  dave = await addUser(ctx, { email: 'dave@example.com', name: 'Dave', role: 'viewer' });
  await bob.client.post('/api/projects', { key: 'web', name: 'Website' });
});

const imp = (c, rows, dryRun) => c.post('/api/projects/WEB/import', { rows, dryRun });

describe('bulk import', () => {
  it('dry run reports per-row errors and writes nothing', async () => {
    const r = await imp(
      bob.client,
      [
        { title: 'Fine' },
        { title: '' },
        {
          title: 'Bad bits',
          type: 'saga',
          priority: 'urgent',
          assignee: 'nobody@example.com',
          status: 'Nope',
          sprint: 'S9',
          due_date: '12/01/2026',
          story_points: 'many',
        },
        { title: 'Orphan sub-task', type: 'subtask' },
        { title: 'Bad parent ref', parent: '#9' },
      ],
      true,
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ dryRun: true, valid: false, invalidRows: 4 });
    expect(r.body.rows[0].errors).toEqual([]);
    expect(r.body.rows[1].errors).toEqual(['Title is required']);
    const e = r.body.rows[2].errors.join(' | ');
    for (const part of [
      'Type must be',
      'Priority must be',
      'Assignee not found',
      'Status not found',
      'Sprint not found',
      'Due date',
      'Story points',
    ])
      expect(e).toContain(part);
    expect(r.body.rows[3].errors).toEqual(['A sub-task needs a parent issue']);
    expect(r.body.rows[4].errors[0]).toContain('earlier row');
    expect((await bob.client.get('/api/issues?project=WEB')).body.total).toBe(0);

    // a real import with errors is refused as a whole
    const real = await imp(bob.client, [{ title: 'Fine' }, { title: '' }]);
    expect(real.status).toBe(400);
    expect(real.body.rows[1].errors).toEqual(['Title is required']);
    expect((await bob.client.get('/api/issues?project=WEB')).body.total).toBe(0);
  });

  it('imports rows with people, labels, parents, status and sprint', async () => {
    const sprint = (await bob.client.post('/api/projects/WEB/sprints', { name: 'Sprint A' })).body.sprint;
    const epic = (await bob.client.post('/api/issues', { projectKey: 'WEB', title: 'Existing epic', type: 'epic' })).body.issue;
    const dry = await imp(
      bob.client,
      [
        { title: 'New epic', type: 'Epic' },
        {
          title: 'Story under new epic',
          type: 'story',
          parent: '#1',
          assignee: 'Carol@example.com',
          labels: 'ui, needs review',
          status: 'in progress',
          sprint: 'sprint a',
          story_points: '5',
          due_date: '2026-12-01',
          estimate_hours: '4',
        },
        {
          title: 'Task under old epic',
          parent: epic.key,
          reporter: 'carol@example.com',
          labels: ['api'],
          priority: 'High',
          description: 'Text',
        },
        { title: 'Sub-task', type: 'Sub-task', parent: '#2', status: 'Done' },
      ],
      true,
    );
    expect(dry.body.valid).toBe(true);

    const r = await imp(bob.client, [
      { title: 'New epic', type: 'Epic' },
      {
        title: 'Story under new epic',
        type: 'story',
        parent: '#1',
        assignee: 'Carol@example.com',
        labels: 'ui, needs review',
        status: 'in progress',
        sprint: 'sprint a',
        story_points: '5',
        due_date: '2026-12-01',
        estimate_hours: '4',
      },
      {
        title: 'Task under old epic',
        parent: epic.key,
        reporter: 'carol@example.com',
        labels: ['api'],
        priority: 'High',
        description: 'Text',
      },
      { title: 'Sub-task', type: 'Sub-task', parent: '#2', status: 'Done' },
    ]);
    expect(r.status).toBe(201);
    expect(r.body.created.map((x) => x.key)).toEqual(['WEB-2', 'WEB-3', 'WEB-4', 'WEB-5']);

    const story = (await bob.client.get('/api/issues/WEB-3')).body.issue;
    expect(story).toMatchObject({
      type: 'story',
      parent: { key: 'WEB-2' },
      assignee: { name: 'Carol' },
      reporter: { name: 'Bob' },
      labels: ['needs', 'review', 'ui'],
      status: { name: 'In Progress' },
      sprint: { id: sprint.id },
      storyPoints: 5,
      dueDate: '2026-12-01',
      estimateHours: 4,
    });
    expect(story.history[0].field).toBe('created');
    expect(story.watchers.map((w) => w.name).sort()).toEqual(['Bob', 'Carol']);
    const task = (await bob.client.get('/api/issues/WEB-4')).body.issue;
    expect(task).toMatchObject({
      type: 'task',
      parent: { key: epic.key },
      reporter: { name: 'Carol' },
      priority: 'high',
      labels: ['api'],
      description: 'Text',
    });
    const sub = (await bob.client.get('/api/issues/WEB-5')).body.issue;
    expect(sub).toMatchObject({ type: 'subtask', parent: { key: 'WEB-3' }, status: { name: 'Done' } });
    expect(sub.resolvedAt).toBeTruthy();

    // the next normal issue continues the sequence
    expect((await bob.client.post('/api/issues', { projectKey: 'WEB', title: 'After' })).body.issue.key).toBe('WEB-6');
    // carol was told about her assignment
    expect(
      (await carol.client.get('/api/notifications')).body.notifications.some((n) => n.type === 'assigned' && n.issueKey === 'WEB-3'),
    ).toBe(true);
    // one audit row
    const entries = (await ctx.admin.get('/api/admin/audit')).body.entries.filter((x) => x.action === 'issues.imported');
    expect(entries).toHaveLength(1);
    expect(entries[0].details).toMatchObject({ count: 4, from: 'WEB-2', to: 'WEB-5' });
  });

  it('checks parent types', async () => {
    const r = await imp(
      bob.client,
      [
        { title: 'A task' },
        { title: 'Story under a task', type: 'story', parent: '#1' },
        { title: 'Epic with parent', type: 'epic', parent: '#1' },
        { title: 'Missing parent', parent: 'WEB-99' },
      ],
      true,
    );
    expect(r.body.rows[1].errors).toEqual(['Only epics can be parents of stories, tasks and bugs']);
    expect(r.body.rows[2].errors).toEqual(['An epic cannot have a parent']);
    expect(r.body.rows[3].errors[0]).toContain('Parent not found');
  });

  it('refuses viewers and non-members of private projects', async () => {
    expect((await imp(dave.client, [{ title: 'x' }], true)).status).toBe(403);
    await bob.client.patch('/api/projects/WEB', { visibility: 'private' });
    expect((await imp(carol.client, [{ title: 'x' }], true)).status).toBe(404);
    await bob.client.put(`/api/projects/WEB/members/${carol.id}`, { role: 'viewer' });
    expect((await imp(carol.client, [{ title: 'x' }])).status).toBe(403);
    await bob.client.put(`/api/projects/WEB/members/${carol.id}`, { role: 'member' });
    expect((await imp(carol.client, [{ title: 'x' }])).status).toBe(201);
  });

  it('caps an import at 500 rows', async () => {
    expect((await imp(bob.client, [])).status).toBe(400);
    const many = Array.from({ length: 501 }, (_, i) => ({ title: `Row ${i + 1}` }));
    const r = await imp(bob.client, many, true);
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('500');
    const ok = await imp(bob.client, many.slice(0, 120));
    expect(ok.status).toBe(201);
    expect(ok.body.created).toHaveLength(120);
    expect((await bob.client.get('/api/issues?project=WEB&limit=1')).body.total).toBe(120);
  });
});
