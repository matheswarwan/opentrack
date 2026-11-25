import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { withAdmin, addUser } from './helpers.js';
import { webhookUrlError, DISABLE_AFTER } from '../server/lib/webhooks.js';
import { NEVER } from '../server/lib/backup.js';

/** Fake receiver: records every request; `answer(url)` gives a status (number) or throws. */
function fakeReceiver() {
  const calls = [];
  const state = { answer: () => 200 };
  async function fetch(url, init = {}) {
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const call = { url, method: init.method, headers, body: init.body, redirect: init.redirect, json: JSON.parse(init.body) };
    calls.push(call);
    const status = state.answer(url, call);
    return new Response('ok', { status });
  }
  return { calls, state, fetch, events: () => calls.map((c) => c.json.event) };
}

let ctx, rx, queue, bob, carol;
async function flush() {
  while (queue.length) await Promise.all(queue.splice(0));
}

async function setup() {
  rx = fakeReceiver();
  queue = [];
  ctx = await withAdmin({ fetch: rx.fetch, slackQueue: queue, PUBLIC_URL: 'https://tracker.example.com' });
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
  await bob.client.post('/api/projects', { key: 'web', name: 'Website' });
}

const ALL = [
  'issue.created',
  'issue.updated',
  'issue.deleted',
  'issue.restored',
  'comment.created',
  'sprint.started',
  'sprint.completed',
  'release.released',
];
const hook = async (who, data = {}, base = '/api/projects/WEB/webhooks') =>
  who.post(base, { url: 'https://hooks.example.com/tracker', events: ALL, ...data });

describe('webhook management', () => {
  beforeEach(setup);

  it('lets project admins manage project webhooks and admins workspace-wide ones', async () => {
    const r = await hook(bob.client, { name: 'CI' });
    expect(r.status).toBe(201);
    expect(r.body.secret).toMatch(/^whsec_/);
    expect(r.body.webhook).toMatchObject({
      scope: 'project',
      projectKey: 'WEB',
      name: 'CI',
      active: true,
      events: ALL,
      includeInternal: false,
      secretLast4: r.body.secret.slice(-4),
    });
    const id = r.body.webhook.id;

    // the secret is never returned again
    const list = await bob.client.get('/api/projects/WEB/webhooks');
    expect(list.status).toBe(200);
    expect(list.body.webhooks).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(r.body.secret);
    expect(JSON.stringify((await bob.client.patch(`/api/webhooks/${id}`, { events: ['issue.created'] })).body)).not.toContain(
      r.body.secret,
    );
    expect((await bob.client.get(`/api/projects/WEB/webhooks`)).body.webhooks[0].events).toEqual(['issue.created']);

    // a member who is not a project admin cannot see or change it
    expect((await carol.client.get('/api/projects/WEB/webhooks')).status).toBe(403);
    expect((await hook(carol.client)).status).toBe(403);
    expect((await carol.client.patch(`/api/webhooks/${id}`, { active: false })).status).toBe(404);
    expect((await carol.client.del(`/api/webhooks/${id}`)).status).toBe(404);
    expect((await carol.client.get(`/api/webhooks/${id}/deliveries`)).status).toBe(404);

    // workspace-wide: admins only
    expect((await hook(bob.client, {}, '/api/admin/webhooks')).status).toBe(403);
    const w = await hook(ctx.admin, {}, '/api/admin/webhooks');
    expect(w.status).toBe(201);
    expect(w.body.webhook.scope).toBe('workspace');
    expect((await bob.client.patch(`/api/webhooks/${w.body.webhook.id}`, { active: false })).status).toBe(404);
    expect((await ctx.admin.get('/api/admin/webhooks')).body.webhooks).toHaveLength(1);
    // admins can manage project webhooks too
    expect((await ctx.admin.patch(`/api/webhooks/${id}`, { active: false })).body.webhook.active).toBe(false);

    // validation
    expect((await hook(bob.client, { events: [] })).status).toBe(400);
    expect((await hook(bob.client, { events: ['issue.exploded'] })).status).toBe(400);

    // delete (with its log), audited by host only
    expect((await bob.client.del(`/api/webhooks/${id}`)).status).toBe(200);
    expect((await bob.client.get('/api/projects/WEB/webhooks')).body.webhooks).toHaveLength(0);
    const audits = await ctx.db.all(`SELECT details FROM audit_log WHERE action LIKE 'webhook.%'`);
    expect(audits.length).toBeGreaterThan(0);
    for (const a of audits) expect(a.details).not.toContain('/tracker');
  });

  it('refuses API tokens', async () => {
    const t = await bob.client.post('/api/me/tokens', { name: 'AI' });
    expect(t.status).toBe(201);
    const r = await ctx.app.request('/api/projects/WEB/webhooks', { headers: { authorization: `Bearer ${t.body.token}` } }, ctx.env);
    expect(r.status).toBe(403);
  });

  it('refuses URLs that are not https or point to private networks', async () => {
    const bad = [
      'http://hooks.example.com/x',
      'ftp://example.com/x',
      'not a url',
      'https://localhost/x',
      'https://foo.localhost/x',
      'https://intranet/x',
      'https://127.0.0.1/x',
      'https://10.1.2.3/x',
      'https://172.20.0.1/x',
      'https://192.168.1.10/x',
      'https://169.254.169.254/latest/meta-data',
      'https://100.64.0.1/x',
      'https://0.0.0.0/x',
      'https://2130706433/x',
      'https://0x7f000001/x',
      'https://[::1]/x',
      'https://[fd00::1]/x',
      'https://[fe80::1]/x',
      'https://[::ffff:127.0.0.1]/x',
      'https://[::ffff:10.0.0.1]/x',
      'https://user:pw@hooks.example.com/x',
      'https://printer.local/x',
    ];
    for (const url of bad) expect(webhookUrlError(url), url).toBeTruthy();
    for (const url of [
      'https://hooks.example.com/x?token=1',
      'https://8.8.8.8/hook',
      'https://[2606:4700::1111]/x',
      'https://example.com:8443/x',
    ])
      expect(webhookUrlError(url), url).toBe(null);
    for (const url of ['http://hooks.example.com/x', 'https://127.0.0.1/x', 'https://169.254.169.254/']) {
      const r = await hook(bob.client, { url });
      expect(r.status, url).toBe(400);
    }
    const ok = (await hook(bob.client)).body.webhook;
    expect((await bob.client.patch(`/api/webhooks/${ok.id}`, { url: 'https://localhost/x' })).status).toBe(400);
    // a URL that got into the table some other way is still never called
    await ctx.db.run('UPDATE webhooks SET url = ? WHERE id = ?', ['https://10.0.0.5/x', ok.id]);
    await bob.client.post('/api/issues', { projectKey: 'WEB', title: 'X' });
    await flush();
    expect(rx.calls).toHaveLength(0);
    const d = (await bob.client.get(`/api/webhooks/${ok.id}/deliveries`)).body.deliveries;
    expect(d[0]).toMatchObject({ ok: false, statusCode: null });
    expect(d[0].error).toMatch(/private/);
  });
});

describe('deliveries', () => {
  beforeEach(setup);

  it('sends each event with a signed payload after the change is saved', async () => {
    const created = (await hook(bob.client)).body;
    const secret = created.secret;
    const issue = (
      await bob.client.post('/api/issues', {
        projectKey: 'WEB',
        type: 'bug',
        title: 'Login broken',
        assigneeId: carol.id,
        priority: 'high',
      })
    ).body.issue;
    await flush();
    expect(rx.calls).toHaveLength(1);
    const c1 = rx.calls[0];
    expect(c1.url).toBe('https://hooks.example.com/tracker');
    expect(c1.method).toBe('POST');
    expect(c1.redirect).toBe('manual');
    expect(c1.headers['content-type']).toBe('application/json');
    expect(c1.headers['x-tracker-event']).toBe('issue.created');
    expect(c1.headers['x-tracker-delivery']).toMatch(/^[0-9a-f-]{36}$/);
    const expected = createHmac('sha256', secret).update(c1.body).digest('hex');
    expect(c1.headers['x-tracker-signature']).toBe(`sha256=${expected}`);
    expect(c1.json).toMatchObject({
      event: 'issue.created',
      workspaceUrl: 'https://tracker.example.com',
      project: { key: 'WEB', name: 'Website' },
      issue: {
        key: issue.key,
        title: 'Login broken',
        type: 'bug',
        status: 'To Do',
        priority: 'high',
        assignee: { name: 'Carol', email: 'carol@example.com' },
        url: `https://tracker.example.com/browse/${issue.key}`,
      },
      actor: { name: 'Bob', email: 'bob@example.com' },
    });
    expect(Date.parse(c1.json.deliveredAt)).toBeGreaterThan(0);

    // update: the changed fields
    const statuses = (await bob.client.get('/api/projects/WEB')).body.project.statuses;
    const done = statuses.find((s) => s.category === 'done');
    await bob.client.patch(`/api/issues/${issue.key}`, { statusId: done.id, title: 'Login fixed' });
    await flush();
    const up = rx.calls[1].json;
    expect(up.event).toBe('issue.updated');
    expect(up.issue).toMatchObject({ title: 'Login fixed', status: done.name });
    expect(up.changes).toEqual(
      expect.arrayContaining([
        { field: 'title', from: 'Login broken', to: 'Login fixed' },
        { field: 'status', from: 'To Do', to: done.name },
      ]),
    );

    // comments: internal notes only to webhooks that opt in
    const internalHook = (
      await hook(bob.client, { url: 'https://internal.example.com/x', events: ['comment.created'], includeInternal: true })
    ).body.webhook;
    rx.calls.length = 0;
    await bob.client.post(`/api/issues/${issue.key}/comments`, { body: 'Public note' });
    await flush();
    expect(rx.calls.map((c) => c.url).sort()).toEqual(['https://hooks.example.com/tracker', 'https://internal.example.com/x']);
    expect(rx.calls[0].json.comment).toMatchObject({
      body: 'Public note',
      internal: false,
      author: { name: 'Bob', email: 'bob@example.com' },
    });
    rx.calls.length = 0;
    const note = (await bob.client.post(`/api/issues/${issue.key}/comments`, { body: 'Secret note', internal: true })).body.comment;
    await flush();
    expect(rx.calls.map((c) => c.url)).toEqual(['https://internal.example.com/x']);
    expect(rx.calls[0].json.comment).toMatchObject({ body: 'Secret note', internal: true, parentId: null });
    // a reply to an internal note is internal too
    rx.calls.length = 0;
    await bob.client.post(`/api/issues/${issue.key}/comments`, { body: 'Reply', parentId: note.id });
    await flush();
    expect(rx.calls.map((c) => c.url)).toEqual(['https://internal.example.com/x']);
    expect(rx.calls[0].json.comment).toMatchObject({ body: 'Reply', internal: true, parentId: note.id });
    await bob.client.del(`/api/webhooks/${internalHook.id}`);

    // delete (to the Trash) and restore
    rx.calls.length = 0;
    await bob.client.del(`/api/issues/${issue.key}`);
    await flush();
    expect(rx.calls[0].json).toMatchObject({ event: 'issue.deleted', issue: { key: issue.key, inTrash: true } });
    await bob.client.post(`/api/trash/${issue.key}/restore`);
    await flush();
    expect(rx.calls[1].json).toMatchObject({ event: 'issue.restored', issue: { key: issue.key } });

    // sprints
    rx.calls.length = 0;
    const sprint = (await bob.client.post('/api/projects/WEB/sprints', { name: 'Sprint A', goal: 'Ship it' })).body.sprint;
    await bob.client.post(`/api/sprints/${sprint.id}/start`, { startDate: '2026-11-01', endDate: '2026-11-14' });
    await bob.client.post(`/api/sprints/${sprint.id}/complete`, {});
    await flush();
    expect(rx.events()).toEqual(['sprint.started', 'sprint.completed']);
    expect(rx.calls[0].json).toMatchObject({
      project: { key: 'WEB' },
      issue: null,
      sprint: { name: 'Sprint A', goal: 'Ship it', startDate: '2026-11-01', endDate: '2026-11-14' },
    });
    expect(rx.calls[1].json.sprint).toMatchObject({ name: 'Sprint A', movedIssues: 0 });

    // releases
    rx.calls.length = 0;
    const rel = (await bob.client.post('/api/projects/WEB/releases', { name: '1.0' })).body.release;
    expect((await bob.client.post(`/api/projects/WEB/releases/${rel.id}/release`, { releaseDate: '2026-11-19' })).status).toBe(200);
    await flush();
    expect(rx.calls[0].json).toMatchObject({
      event: 'release.released',
      release: { name: '1.0', releaseDate: '2026-11-19' },
      project: { key: 'WEB' },
    });
  });

  it('sends only the chosen events, skips inactive webhooks, and includes workspace-wide ones for every project', async () => {
    const only = (await hook(bob.client, { events: ['comment.created'] })).body.webhook;
    const off = (await hook(bob.client, { url: 'https://off.example.com/x' })).body.webhook;
    await bob.client.patch(`/api/webhooks/${off.id}`, { active: false });
    await hook(ctx.admin, { url: 'https://all.example.com/x', events: ['issue.created'] }, '/api/admin/webhooks');
    await ctx.admin.post('/api/projects', { key: 'OPS', name: 'Ops', visibility: 'private' });
    const i = (await bob.client.post('/api/issues', { projectKey: 'WEB', title: 'A' })).body.issue;
    await ctx.admin.post('/api/issues', { projectKey: 'OPS', title: 'B' });
    await bob.client.post(`/api/issues/${i.key}/comments`, { body: 'Hi' });
    await flush();
    expect(rx.calls.map((c) => `${c.url} ${c.json.event} ${c.json.project.key}`).sort()).toEqual([
      'https://all.example.com/x issue.created OPS',
      'https://all.example.com/x issue.created WEB',
      'https://hooks.example.com/tracker comment.created WEB',
    ]);
    expect(only.id).toBeTruthy();
  });

  it('keeps a log of the last 50 deliveries with the first 2 KB of each body', async () => {
    const h = (await hook(bob.client)).body.webhook;
    const i = (await bob.client.post('/api/issues', { projectKey: 'WEB', title: 'Log me' })).body.issue;
    await bob.client.post(`/api/issues/${i.key}/comments`, { body: 'x'.repeat(5000) });
    await flush();
    const d = (await bob.client.get(`/api/webhooks/${h.id}/deliveries`)).body.deliveries;
    expect(d).toHaveLength(2);
    expect(d[0]).toMatchObject({ event: 'comment.created', ok: true, statusCode: 200, error: null, test: false, payloadCut: true });
    expect(d[0].payload.length).toBe(2048);
    expect(d[0].payloadSize).toBeGreaterThan(5000);
    expect(d[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(d[1]).toMatchObject({ event: 'issue.created', payloadCut: false });
    expect(JSON.parse(d[1].payload).issue.key).toBe(i.key);
    // the id in the log is the X-Tracker-Delivery header
    expect(rx.calls.map((c) => c.headers['x-tracker-delivery']).sort()).toEqual(d.map((x) => x.id).sort());

    for (let n = 0; n < 52; n++) await bob.client.post(`/api/issues/${i.key}/comments`, { body: `c${n}` });
    await flush();
    const all = await ctx.db.all('SELECT id FROM webhook_deliveries WHERE webhook_id = ?', [h.id]);
    expect(all).toHaveLength(50);
    const list = (await bob.client.get(`/api/webhooks/${h.id}/deliveries`)).body.deliveries;
    expect(JSON.parse(list[0].payload).comment.body).toBe('c51');
  });

  it('records failures: error status, network errors and redirects (not followed)', async () => {
    const h = (await hook(bob.client)).body.webhook;
    let n = 0;
    rx.state.answer = () => {
      n += 1;
      if (n === 1) return 500;
      if (n === 2) throw new Error('connection refused');
      return 302;
    };
    for (const t of ['A', 'B', 'C']) await bob.client.post('/api/issues', { projectKey: 'WEB', title: t });
    await flush();
    const d = (await bob.client.get(`/api/webhooks/${h.id}/deliveries`)).body.deliveries;
    expect(d.map((x) => x.ok)).toEqual([false, false, false]);
    expect(d.map((x) => x.error).sort()).toEqual(['Could not connect: connection refused', 'HTTP 500', 'Redirects are not followed']);
    const w = (await bob.client.get('/api/projects/WEB/webhooks')).body.webhooks[0];
    expect(w.failureCount).toBe(3);
    expect(w.active).toBe(true);
  });

  it('sends a test ping and redelivers a logged delivery', async () => {
    const created = (await hook(bob.client)).body;
    const h = created.webhook;
    const t = await bob.client.post(`/api/webhooks/${h.id}/test`);
    expect(t.status).toBe(200);
    expect(t.body.delivery).toMatchObject({ ok: true, status: 200 });
    expect(rx.calls[0].json).toMatchObject({ event: 'ping', project: { key: 'WEB' }, webhook: { id: h.id }, actor: { name: 'Bob' } });
    expect(rx.calls[0].headers['x-tracker-signature']).toBe(
      `sha256=${createHmac('sha256', created.secret).update(rx.calls[0].body).digest('hex')}`,
    );

    const i = (await bob.client.post('/api/issues', { projectKey: 'WEB', title: 'Again' })).body.issue;
    await flush();
    const first = (await bob.client.get(`/api/webhooks/${h.id}/deliveries`)).body.deliveries.find((x) => x.event === 'issue.created');
    const r = await bob.client.post(`/api/webhooks/${h.id}/deliveries/${first.id}/redeliver`);
    expect(r.status).toBe(200);
    expect(r.body.delivery.ok).toBe(true);
    const last = rx.calls[rx.calls.length - 1];
    expect(last.json).toMatchObject({ event: 'issue.created', issue: { key: i.key } });
    expect(last.headers['x-tracker-delivery']).not.toBe(first.id);
    const log = (await bob.client.get(`/api/webhooks/${h.id}/deliveries`)).body.deliveries;
    expect(log[0]).toMatchObject({ redeliveryOf: first.id, event: 'issue.created' });
    expect(log.find((x) => x.event === 'ping').test).toBe(true);
    expect((await carol.client.post(`/api/webhooks/${h.id}/test`)).status).toBe(404);
    expect((await bob.client.post(`/api/webhooks/${h.id}/deliveries/nope/redeliver`)).status).toBe(404);
  });

  it(`turns a webhook off after ${DISABLE_AFTER} failures in a row and tells its creator`, async () => {
    const h = (await hook(bob.client)).body.webhook;
    rx.state.answer = () => 503;
    const i = (await bob.client.post('/api/issues', { projectKey: 'WEB', title: 'Noisy' })).body.issue; // failure 1
    await flush();
    // test pings do not count
    for (let n = 0; n < 3; n++) await bob.client.post(`/api/webhooks/${h.id}/test`);
    for (let n = 0; n < DISABLE_AFTER - 2; n++) await bob.client.post(`/api/issues/${i.key}/comments`, { body: `c${n}` });
    await flush();
    let w = (await bob.client.get('/api/projects/WEB/webhooks')).body.webhooks[0];
    expect(w).toMatchObject({ active: true, failureCount: DISABLE_AFTER - 1 });
    expect((await bob.client.get('/api/notifications')).body.notifications.filter((x) => x.type === 'webhook')).toHaveLength(0);

    await bob.client.post(`/api/issues/${i.key}/comments`, { body: 'last straw' });
    await flush();
    w = (await bob.client.get('/api/projects/WEB/webhooks')).body.webhooks[0];
    expect(w.active).toBe(false);
    expect(w.disabledReason).toMatch(/20 failed deliveries/);
    const notes = (await bob.client.get('/api/notifications')).body.notifications.filter((x) => x.type === 'webhook');
    expect(notes).toHaveLength(1);
    expect(notes[0].message).toMatch(/hooks\.example\.com was turned off/);
    expect(await ctx.db.get(`SELECT id FROM audit_log WHERE action = 'webhook.auto_disabled'`)).toBeTruthy();

    // no more deliveries while off
    const before = rx.calls.length;
    await bob.client.post(`/api/issues/${i.key}/comments`, { body: 'ignored' });
    await flush();
    expect(rx.calls.length).toBe(before);

    // on again: the count starts afresh; a success resets it too
    rx.state.answer = () => 200;
    w = (await bob.client.patch(`/api/webhooks/${h.id}`, { active: true })).body.webhook;
    expect(w).toMatchObject({ active: true, failureCount: 0, disabledReason: null });
  });

  it('skips webhooks for quiet bulk changes', async () => {
    await hook(bob.client, { events: ['issue.updated', 'issue.deleted'] });
    const keys = [];
    for (let n = 0; n < 3; n++) keys.push((await bob.client.post('/api/issues', { projectKey: 'WEB', title: `B${n}` })).body.issue.key);
    await bob.client.post('/api/issues/bulk', { keys, changes: { priority: 'low' }, quiet: true });
    await bob.client.post('/api/issues/bulk', { keys, action: 'delete', quiet: true });
    await flush();
    expect(rx.calls).toHaveLength(0);
    const one = (await bob.client.post('/api/issues', { projectKey: 'WEB', title: 'Loud' })).body.issue;
    await bob.client.post('/api/issues/bulk', { keys: [one.key], changes: { priority: 'high' } });
    await flush();
    expect(rx.events()).toEqual(['issue.updated']);
  });
});

describe('secrets', () => {
  beforeEach(setup);

  it('are never in backups', async () => {
    const created = (await hook(bob.client)).body;
    await bob.client.post('/api/issues', { projectKey: 'WEB', title: 'Backed up' });
    await flush();
    expect(NEVER.tables).toEqual(expect.arrayContaining(['webhooks', 'webhook_deliveries']));
    expect(NEVER.columns).toContain('signing_secret');
    const r = await ctx.admin.get('/api/admin/backup');
    expect(r.status).toBe(200);
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    const b = typeof r.body === 'string' ? JSON.parse(r.body) : r.body;
    expect(b.complete).toBe(true);
    expect(b.tables.webhooks).toBeUndefined();
    expect(b.tables.webhook_deliveries).toBeUndefined();
    expect(text).not.toContain(created.secret);
    expect(text).not.toContain('hooks.example.com/tracker'); // the audit log keeps only the host
    const p = await bob.client.get('/api/projects/WEB/export.json');
    expect(p.status).toBe(200);
    expect(JSON.stringify(p.body)).not.toContain(created.secret);
  });
});
