// Workflow rules (server/lib/workflow.js): allowed transitions, required values and automations on entering a status.
import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser } from './helpers.js';

let ctx, bob, carol, gina, token, st;
// WEB: open project, Bob is its admin; Carol a member. Statuses: To Do, In Progress, In Review, Done.
beforeEach(async () => {
  ctx = await withAdmin();
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
  gina = await addUser(ctx, { email: 'gina@client.example', name: 'Gina Guest', role: 'guest' });
  const p = (await bob.client.post('/api/projects', { key: 'WEB', name: 'Website' })).body.project;
  await bob.client.put(`/api/projects/WEB/members/${carol.id}`, { role: 'member' });
  st = Object.fromEntries(p.statuses.map((s) => [s.name, s.id]));
  token = (await carol.client.post('/api/me/tokens', { name: 'mcp' })).body.token;
});

const flow = (data, who = bob) => who.client.put('/api/projects/WEB/workflow', data);
const issue = async (data = {}, who = carol) =>
  (await who.client.post('/api/issues', { projectKey: 'WEB', title: 'Task', ...data })).body.issue;
const get = async (key) => (await bob.client.get(`/api/issues/${key}`)).body.issue;
// To Do -> In Progress -> In Review -> Done, and back from In Review to In Progress
const linear = () => ({
  transitions: {
    [st['To Do']]: [st['In Progress']],
    [st['In Progress']]: [st['In Review']],
    [st['In Review']]: [st.Done, st['In Progress']],
    [st.Done]: [st['To Do']],
  },
});
async function mcp(name, args) {
  const res = await ctx.app.request(
    'http://t.example/mcp',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    },
    ctx.env,
  );
  const r = (await res.json()).result;
  return { error: r.isError ? r.content[0].text : null, data: r.isError ? null : JSON.parse(r.content[0].text) };
}

describe('workflow settings', () => {
  it('only project admins can read and change them; values are checked', async () => {
    expect((await flow(linear(), carol)).status).toBe(403);
    expect((await carol.client.get('/api/projects/WEB/workflow')).status).toBe(403);
    expect((await flow({ transitions: { nope: [] } })).status).toBe(400);
    expect((await flow({ transitions: { [st['To Do']]: ['nope'] } })).status).toBe(400);
    expect((await flow({ statuses: { [st.Done]: { required: ['shoe size'] } } })).status).toBe(400);
    expect((await flow({ statuses: { [st.Done]: { actions: { assignee: { to: 'user', userId: gina.id } } } } })).status).toBe(400); // a guest outside the project
    const r = await flow(linear());
    expect(r.status).toBe(200);
    expect(r.body.workflow.transitions[st['To Do']]).toEqual([st['In Progress']]);
    // every member gets the summary in the project payload (board dimming)
    const p = (await carol.client.get('/api/projects/WEB')).body.project;
    expect(p.workflow).toMatchObject({ adminBypass: true, transitions: { [st['To Do']]: [st['In Progress']] } });
  });

  it('a deleted status drops out of the rules', async () => {
    await flow({ ...linear(), statuses: { [st['In Review']]: { required: ['assignee'] } } });
    await bob.client.del(`/api/projects/WEB/statuses/${st['In Review']}?moveTo=${st['In Progress']}`);
    const w = (await bob.client.get('/api/projects/WEB/workflow')).body.workflow;
    expect(w.transitions[st['In Review']]).toBeUndefined();
    expect(w.transitions[st['In Progress']]).toEqual([]);
    expect(w.statuses[st['In Review']]).toBeUndefined();
  });
});

describe('allowed transitions', () => {
  it('are enforced on PATCH with a clear message; any to any without rules', async () => {
    const i = await issue();
    expect((await carol.client.patch(`/api/issues/${i.key}`, { statusId: st.Done })).status).toBe(200); // no rules yet
    await carol.client.patch(`/api/issues/${i.key}`, { statusId: st['To Do'] });
    await flow(linear());
    const r = await carol.client.patch(`/api/issues/${i.key}`, { statusId: st.Done });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Moving from To Do to Done is not allowed. Allowed: In Progress.');
    expect(r.body.allowed).toEqual([st['In Progress']]);
    expect((await get(i.key)).status.name).toBe('To Do');
    expect((await carol.client.patch(`/api/issues/${i.key}`, { statusId: st['In Progress'] })).status).toBe(200);
    // other changes are not affected
    expect((await carol.client.patch(`/api/issues/${i.key}`, { title: 'Renamed' })).status).toBe(200);
    // the refusal wrote no history
    expect((await get(i.key)).history.filter((h) => h.field === 'status').map((h) => h.to)).toEqual(['Done', 'To Do', 'In Progress']);
  });

  it('project admins bypass them unless turned off', async () => {
    const i = await issue();
    await flow(linear());
    expect((await bob.client.patch(`/api/issues/${i.key}`, { statusId: st.Done })).status).toBe(200);
    await bob.client.patch(`/api/issues/${i.key}`, { statusId: st['To Do'] });
    await flow({ ...linear(), adminBypass: false });
    expect((await bob.client.patch(`/api/issues/${i.key}`, { statusId: st.Done })).status).toBe(400);
    expect((await ctx.admin.patch(`/api/issues/${i.key}`, { statusId: st.Done })).status).toBe(400); // workspace admins too
  });

  it('are enforced on board moves without changing the rank', async () => {
    const a = await issue({ title: 'A' });
    const b = await issue({ title: 'B' });
    await flow(linear());
    const before = (await get(a.key)).rank;
    const r = await carol.client.post(`/api/issues/${a.key}/move`, { statusId: st.Done, prevKey: b.key });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('not allowed');
    expect((await carol.client.get(`/api/issues/${a.key}`)).body.issue.rank).toBe(before);
    const ok = await carol.client.post(`/api/issues/${a.key}/move`, { statusId: st['In Progress'], prevKey: b.key });
    expect(ok.status).toBe(200);
    expect(ok.body.issue.status.name).toBe('In Progress');
  });

  it('are enforced per issue in bulk', async () => {
    const a = await issue();
    const b = await issue();
    await carol.client.patch(`/api/issues/${b.key}`, { statusId: st['In Progress'] });
    await flow(linear());
    const r = await carol.client.post('/api/issues/bulk', { keys: [a.key, b.key], changes: { statusId: st['In Review'] } });
    expect(r.body.results).toEqual([
      { key: a.key, ok: false, error: 'Moving from To Do to In Review is not allowed. Allowed: In Progress.' },
      { key: b.key, ok: true, changed: ['status'] },
    ]);
  });

  it('are enforced on MCP update_issue', async () => {
    const i = await issue();
    await flow(linear());
    const r = await mcp('update_issue', { key: i.key, status: 'Done' });
    expect(r.error).toContain('Moving from To Do to Done is not allowed');
    expect((await mcp('update_issue', { key: i.key, status: 'In Progress' })).data.now.status).toBe('In Progress');
  });

  it('apply to guests too, and give guests no new rights', async () => {
    await bob.client.put(`/api/projects/WEB/members/${gina.id}`, { role: 'guest-edit' });
    const own = await issue({}, gina);
    await flow(linear());
    expect((await gina.client.patch(`/api/issues/${own.key}`, { statusId: st.Done })).status).toBe(400);
    expect((await gina.client.patch(`/api/issues/${own.key}`, { statusId: st['In Progress'] })).status).toBe(200);
    const other = await issue();
    expect((await gina.client.patch(`/api/issues/${other.key}`, { statusId: st['In Progress'] })).status).toBe(403);
    await bob.client.put(`/api/projects/WEB/members/${gina.id}`, { role: 'guest-view' });
    expect((await gina.client.patch(`/api/issues/${own.key}`, { statusId: st['In Review'] })).status).toBe(403);
  });
});

describe('required values', () => {
  it('ask for missing values and accept them in the same change', async () => {
    const rel = (await bob.client.post('/api/projects/WEB/releases', { name: '1.0' })).body.release;
    const field = (await bob.client.post('/api/projects/WEB/fields', { name: 'Client', type: 'select', options: [{ name: 'Acme' }] })).body
      .field;
    await flow({ statuses: { [st.Done]: { required: ['assignee', 'fixVersion', `cf:${field.id}`, 'comment'] } } });
    const i = await issue();
    const r = await carol.client.patch(`/api/issues/${i.key}`, { statusId: st.Done });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('required');
    expect(r.body.missing.map((m) => m.key)).toEqual(['assignee', 'fixVersion', `cf:${field.id}`, 'comment']);
    expect(r.body.missing[2]).toMatchObject({ label: 'Client', fieldId: field.id, type: 'select' });
    expect(r.body.error).toBe('Moving to Done needs: Assignee, Fix version, Client, Resolution comment.');
    expect((await get(i.key)).status.name).toBe('To Do');
    // values already on the issue count
    await carol.client.patch(`/api/issues/${i.key}`, { assigneeId: carol.id, fields: { [field.id]: 'Acme' } });
    const r2 = await carol.client.patch(`/api/issues/${i.key}`, { statusId: st.Done });
    expect(r2.body.missing.map((m) => m.key)).toEqual(['fixVersion', 'comment']);
    const ok = await carol.client.patch(`/api/issues/${i.key}`, { statusId: st.Done, fixVersions: [rel.id], comment: 'Shipped in 1.0' });
    expect(ok.status).toBe(200);
    const d = await get(i.key);
    expect(d.status.name).toBe('Done');
    expect(d.fixVersions.map((x) => x.name)).toEqual(['1.0']);
    expect(d.comments.map((c) => c.body)).toEqual(['Shipped in 1.0']);
  });

  it('cannot be dodged by clearing in the same change, and a comment needs a status change', async () => {
    await flow({ statuses: { [st['In Progress']]: { required: ['storyPoints', 'dueDate', 'estimate', 'components'] } } });
    const comp = (await bob.client.post('/api/projects/WEB/components', { name: 'API' })).body.component;
    const i = await issue({ storyPoints: 3 });
    const r = await carol.client.patch(`/api/issues/${i.key}`, { statusId: st['In Progress'], storyPoints: null });
    expect(r.body.missing.map((m) => m.key)).toEqual(['storyPoints', 'dueDate', 'estimate', 'components']);
    expect(
      (
        await carol.client.patch(`/api/issues/${i.key}`, {
          statusId: st['In Progress'],
          dueDate: '2026-12-01',
          estimateHours: 4,
          components: [comp.id],
        })
      ).status,
    ).toBe(200);
    expect((await carol.client.patch(`/api/issues/${i.key}`, { comment: 'no move' })).status).toBe(400);
  });

  it('board moves accept the asked values as extra', async () => {
    await flow({ statuses: { [st.Done]: { required: ['dueDate'] } } });
    const i = await issue();
    const r = await carol.client.post(`/api/issues/${i.key}/move`, { statusId: st.Done });
    expect(r.body.missing.map((m) => m.key)).toEqual(['dueDate']);
    const ok = await carol.client.post(`/api/issues/${i.key}/move`, {
      statusId: st.Done,
      extra: { dueDate: '2026-12-24', title: 'ignored' },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.issue).toMatchObject({ dueDate: '2026-12-24', title: 'Task' });
  });
});

describe('automations on entering a status', () => {
  it('set the assignee (person, reporter, current user, clear)', async () => {
    const i = await issue({}, bob);
    await flow({
      statuses: {
        [st['In Progress']]: { actions: { assignee: { to: 'actor' } } },
        [st['In Review']]: { actions: { assignee: { to: 'user', userId: bob.id } } },
        [st.Done]: { actions: { assignee: { to: 'reporter' } } },
        [st['To Do']]: { actions: { assignee: { to: 'clear' } } },
      },
    });
    const step = async (name) =>
      (await carol.client.patch(`/api/issues/${i.key}`, { statusId: st[name] })).body.issue.assignee?.name ?? null;
    expect(await step('In Progress')).toBe('Carol');
    expect(await step('In Review')).toBe('Bob');
    await carol.client.patch(`/api/issues/${i.key}`, { assigneeId: carol.id });
    expect(await step('Done')).toBe('Bob'); // the reporter
    expect(await step('To Do')).toBe(null);
    // an explicit assignee in the same change wins
    expect(
      (await carol.client.patch(`/api/issues/${i.key}`, { statusId: st['In Progress'], assigneeId: bob.id })).body.issue.assignee.name,
    ).toBe('Bob');
    const hist = (await get(i.key)).history.filter((h) => h.field === 'assignee').map((h) => h.to);
    expect(hist).toEqual(['Carol', 'Bob', 'Carol', 'Bob', null, 'Bob']);
  });

  it('change labels, set a custom field, comment and move to a sprint', async () => {
    const field = (await bob.client.post('/api/projects/WEB/fields', { name: 'QA', type: 'text' })).body.field;
    const sprint = (await bob.client.post('/api/projects/WEB/sprints', { name: 'S1' })).body.sprint;
    await bob.client.post(`/api/sprints/${sprint.id}/start`, {});
    await flow({
      statuses: {
        [st['In Progress']]: { actions: { addLabels: ['wip'], removeLabels: ['triage'], sprint: 'active' } },
        [st['In Review']]: { actions: { field: { fieldId: field.id, value: 'Pending' }, comment: '{user} moved {key} to {status}.' } },
        [st['To Do']]: { actions: { sprint: 'backlog', removeLabels: ['wip'] } },
      },
    });
    await bob.client.patch('/api/projects/WEB', { permissions: { sprints: 'admins' } }); // Carol cannot manage sprints herself
    const i = await issue({ labels: ['triage', 'web'] });
    const a = (await carol.client.patch(`/api/issues/${i.key}`, { statusId: st['In Progress'] })).body.issue;
    expect(a.labels.sort()).toEqual(['web', 'wip']);
    expect(a.sprint.name).toBe('S1');
    await carol.client.patch(`/api/issues/${i.key}`, { statusId: st['In Review'] });
    const d = await get(i.key);
    expect(d.fields[field.id]).toBe('Pending');
    expect(d.comments.map((c) => [c.body, c.author.name])).toEqual([[`Carol moved ${i.key} to In Review.`, 'Carol']]);
    const back = (await carol.client.patch(`/api/issues/${i.key}`, { statusId: st['To Do'] })).body.issue;
    expect(back.sprint).toBe(null);
    expect(back.labels).toEqual(['web']);
    // without a status change Carol still cannot move it between sprints
    expect((await carol.client.patch(`/api/issues/${i.key}`, { sprintId: sprint.id })).status).toBe(403);
    const fields = (await get(i.key)).history.map((h) => h.field);
    expect(fields).toEqual(expect.arrayContaining(['labels', 'sprint', `field:QA`, 'status']));
  });

  it('notify watchers with a custom message instead of the usual one', async () => {
    await flow({ statuses: { [st.Done]: { actions: { notify: '{key} is done, thanks {user}' } } } });
    const i = await issue({}, bob);
    await carol.client.patch(`/api/issues/${i.key}`, { statusId: st.Done });
    const n = (await bob.client.get('/api/notifications')).body.notifications.filter((x) => x.type === 'status');
    expect(n.map((x) => x.message)).toEqual([`${i.key} is done, thanks Carol`]);
  });

  it('run once per move and never trigger other rules', async () => {
    // entering In Progress assigns the reporter and adds a label; nothing chains into In Review's rules
    await flow({
      statuses: {
        [st['In Progress']]: { actions: { addLabels: ['started'], comment: 'Started' } },
        [st['In Review']]: { actions: { comment: 'Review' } },
      },
    });
    const i = await issue();
    await carol.client.patch(`/api/issues/${i.key}`, { statusId: st['In Progress'] });
    await carol.client.patch(`/api/issues/${i.key}`, { title: 'Edited', labels: ['other'] }); // no status change: no automation
    const d = await get(i.key);
    expect(d.status.name).toBe('In Progress');
    expect(d.comments.map((c) => c.body)).toEqual(['Started']);
    expect(d.labels).toEqual(['other']);
  });

  it('skip a rule whose person cannot be assigned any more', async () => {
    await flow({ statuses: { [st.Done]: { actions: { assignee: { to: 'user', userId: carol.id } } } } });
    await ctx.admin.patch(`/api/admin/users/${carol.id}`, { status: 'deactivated' });
    const i = await issue({}, bob);
    const r = await bob.client.patch(`/api/issues/${i.key}`, { statusId: st.Done });
    expect(r.status).toBe(200);
    expect(r.body.issue.assignee).toBe(null);
  });
});
