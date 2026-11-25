import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser } from './helpers.js';
import { applyTitlePrefix } from '../server/lib/issues/templates.js';

let ctx, bob, carol;
beforeEach(async () => {
  ctx = await withAdmin();
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
  await bob.client.post('/api/projects', { key: 'web', name: 'Website' });
});

const T = '/api/projects/WEB/templates';

describe('issue templates', () => {
  it('lets project admins manage them and everyone who can see the project read them', async () => {
    expect((await bob.client.get(T)).body.templates).toEqual([]);
    const add = await bob.client.post(T, {
      name: 'Incident',
      type: 'bug',
      titlePrefix: '  [Incident] ',
      description: '## Impact',
      priority: 'highest',
      labels: ['ops', 'ops'],
      subtasks: ['Post-mortem', ' ', 'Notify customers'],
    });
    expect(add.status).toBe(201);
    expect(add.body.template).toMatchObject({
      name: 'Incident',
      type: 'bug',
      titlePrefix: '[Incident] ',
      priority: 'highest',
      labels: ['ops'],
      subtasks: ['Post-mortem', 'Notify customers'],
    });
    const id = add.body.template.id;
    // carol can read (open project) but not change
    expect((await carol.client.get(T)).body.templates).toHaveLength(1);
    expect((await carol.client.post(T, { name: 'x' })).status).toBe(403);
    expect((await carol.client.patch(`${T}/${id}`, { name: 'x' })).status).toBe(403);
    expect((await carol.client.del(`${T}/${id}`)).status).toBe(403);
    // validation
    expect((await bob.client.post(T, { name: 'incident' })).status).toBe(409);
    expect((await bob.client.post(T, { name: '' })).status).toBe(400);
    expect((await bob.client.post(T, { name: 'E', type: 'epic', subtasks: ['x'] })).status).toBe(400);
    expect((await bob.client.post(T, { name: 'P', priority: 'urgent' })).status).toBe(400);
    expect((await bob.client.patch(`${T}/${id}`, { type: 'epic' })).status).toBe(400); // it has sub-tasks
    // edit and delete
    const ed = await bob.client.patch(`${T}/${id}`, { name: 'Outage', subtasks: [], priority: null });
    expect(ed.body.template).toMatchObject({ name: 'Outage', subtasks: [], priority: null, titlePrefix: '[Incident] ' });
    expect((await bob.client.patch(`${T}/${id}`, { type: 'epic' })).status).toBe(200);
    expect((await bob.client.del(`${T}/${id}`)).status).toBe(200);
    expect((await bob.client.get(T)).body.templates).toEqual([]);
    // private project: non-members cannot see them
    await bob.client.patch('/api/projects/WEB', { visibility: 'private' });
    expect((await carol.client.get(T)).status).toBe(404);
  });

  it('adds the standard set once', async () => {
    await bob.client.post(T, { name: 'task' });
    expect((await carol.client.post(`${T}/standard`)).status).toBe(403);
    const r = await bob.client.post(`${T}/standard`);
    expect(r.body.added).toEqual(['Bug report', 'Feature request']);
    expect(r.body.templates.map((t) => t.name)).toEqual(['task', 'Bug report', 'Feature request']);
    const bug = r.body.templates.find((t) => t.name === 'Bug report');
    expect(bug).toMatchObject({ type: 'bug', titlePrefix: '[Bug] ' });
    for (const h of ['What happens', 'Expected', 'Steps', 'Environment']) expect(bug.description).toContain(h);
    expect(r.body.templates.find((t) => t.name === 'Feature request').description).toContain('- [ ]');
    expect((await bob.client.post(`${T}/standard`)).body.added).toEqual([]);
  });

  it('applies a title prefix or pattern once', () => {
    expect(applyTitlePrefix('[Bug] ', 'Login fails')).toBe('[Bug] Login fails');
    expect(applyTitlePrefix('[Bug] ', '[Bug] Login fails')).toBe('[Bug] Login fails');
    expect(applyTitlePrefix('Release {title} notes', '2.0')).toBe('Release 2.0 notes');
    expect(applyTitlePrefix('', 'x')).toBe('x');
  });

  it('creates an issue from a template and then its sub-tasks (the web app path)', async () => {
    const t = (
      await bob.client.post(T, {
        name: 'Release',
        type: 'task',
        titlePrefix: 'Release ',
        labels: ['release'],
        subtasks: ['Changelog', 'Tag'],
      })
    ).body.template;
    const { issue } = (
      await bob.client.post('/api/issues', {
        projectKey: 'WEB',
        type: t.type,
        title: applyTitlePrefix(t.titlePrefix, '2.0'),
        labels: t.labels,
      })
    ).body;
    for (const title of t.subtasks)
      expect((await bob.client.post('/api/issues', { projectKey: 'WEB', type: 'subtask', parentKey: issue.key, title })).status).toBe(201);
    const d = (await bob.client.get(`/api/issues/${issue.key}`)).body.issue;
    expect(d.title).toBe('Release 2.0');
    expect(d.children.map((c) => c.title)).toEqual(['Changelog', 'Tag']);
  });
});

describe('MCP create_issue with a template', () => {
  let token;
  beforeEach(async () => {
    token = (await bob.client.post('/api/me/tokens', { name: 'Claude' })).body.token;
    await bob.client.post(T, {
      name: 'Bug report',
      type: 'bug',
      titlePrefix: '[Bug] ',
      description: '## Steps',
      priority: 'high',
      labels: ['triage'],
      subtasks: ['Reproduce', 'Fix'],
    });
  });
  let id = 0;
  async function tool(name, args) {
    const res = await ctx.app.request(
      'http://t.example/mcp',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
      },
      ctx.env,
    );
    const r = (await res.json()).result;
    return { error: r.isError ? r.content[0].text : null, data: r.isError ? null : JSON.parse(r.content[0].text) };
  }

  it('fills fields from the template and creates its sub-tasks', async () => {
    const r = await tool('create_issue', { project: 'WEB', title: 'Login fails', template: 'bug REPORT', labels: ['auth'] });
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({
      created: 'WEB-1',
      title: '[Bug] Login fails',
      type: 'bug',
      priority: 'high',
      labels: ['auth', 'triage'],
      subtasks: ['WEB-2', 'WEB-3'],
    });
    const d = (await bob.client.get('/api/issues/WEB-1')).body.issue;
    expect(d.description).toBe('## Steps');
    expect(d.children.map((c) => c.title)).toEqual(['Reproduce', 'Fix']);
    // explicit arguments win
    const r2 = await tool('create_issue', {
      project: 'WEB',
      title: '[Bug] Twice',
      template: 'Bug report',
      priority: 'low',
      description: 'Mine',
    });
    expect(r2.data).toMatchObject({ title: '[Bug] Twice', priority: 'low' });
    const bad = await tool('create_issue', { project: 'WEB', title: 'x', template: 'Nope' });
    expect(bad.error).toMatch(/No template "Nope" in WEB\. Templates: Bug report/);
  });
});
