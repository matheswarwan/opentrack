import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser } from './helpers.js';
import { plainText, notificationEmail } from '../server/lib/email.js';

const EMAIL_ENV = { POSTMARK_SERVER_TOKEN: 'pm-test-token', EMAIL_FROM: 'Opentrack <tracker@example.com>' };

/** Fake Postmark: records each email; `fail` makes the next sends fail with a Postmark error. */
function fakePostmark() {
  const sent = [];
  const state = { fail: false };
  async function fetch(url, init = {}) {
    const b = JSON.parse(init.body);
    sent.push({ url, token: init.headers['X-Postmark-Server-Token'], ...b });
    if (state.fail)
      return new Response(JSON.stringify({ ErrorCode: 300, Message: 'Invalid email request' }), {
        status: 422,
        headers: { 'content-type': 'application/json' },
      });
    return new Response(JSON.stringify({ ErrorCode: 0, Message: 'OK', MessageID: 'm1' }), {
      headers: { 'content-type': 'application/json' },
    });
  }
  return { sent, state, fetch, to: (email) => sent.filter((s) => s.To === email) };
}

let ctx, pm, bob, carol, queue;
async function flush() {
  while (queue.length) await Promise.all(queue.splice(0));
}
const create = (c, data) => c.post('/api/issues', { projectKey: 'WEB', ...data });
const mention = (u, name) => `@[${name}](user:${u.id})`;

async function setup(extra = EMAIL_ENV) {
  pm = fakePostmark();
  queue = [];
  ctx = await withAdmin({ fetch: pm.fetch, slackQueue: queue, PUBLIC_URL: 'https://tracker.example.com', ...extra });
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
  await bob.client.post('/api/projects', { key: 'web', name: 'Website' });
  await flush();
  pm.sent.length = 0;
}

describe('notification emails', () => {
  beforeEach(() => setup());

  it('emails assignments and mentions by default; the actor only for a self-mention', async () => {
    const r = await create(bob.client, { title: 'Requirements', assigneeId: carol.id, description: `Hi ${mention(bob, 'Bob')}` });
    expect(r.status).toBe(201);
    await flush();
    // the actor mentioned themselves: a reminder email, nothing for their own assignment of Carol
    expect(pm.to('bob@example.com').map((m) => m.Subject)).toEqual(['[WEB-1] Bob mentioned you: Requirements']);
    const [m] = pm.to('carol@example.com');
    expect(m).toBeTruthy();
    expect(m.url).toBe('https://api.postmarkapp.com/email');
    expect(m.token).toBe('pm-test-token');
    expect(m.From).toBe(EMAIL_ENV.EMAIL_FROM);
    expect(m.MessageStream).toBe('outbound');
    expect(m.Subject).toBe('[WEB-1] Bob assigned you: Requirements');
    expect(m.TextBody).toContain('https://tracker.example.com/browse/WEB-1');
    expect(m.TextBody).toContain('https://tracker.example.com/profile');

    pm.sent.length = 0;
    const c = await bob.client.post('/api/issues/WEB-1/comments', {
      body: `**Please** check ${mention(carol, 'Carol')} <script>x</script>`,
    });
    expect(c.status).toBe(201);
    await flush();
    const [mm] = pm.to('carol@example.com');
    expect(mm.Subject).toBe('[WEB-1] Bob mentioned you: Requirements');
    expect(mm.TextBody).toContain('Please check @Carol');
    expect(mm.TextBody).not.toContain('user:');
    expect(mm.HtmlBody).not.toContain('<script>');
  });

  it('sends comment and status emails only when opted in', async () => {
    await create(bob.client, { title: 'Watch me' });
    await carol.client.post('/api/issues/WEB-1/watch');
    await bob.client.post('/api/issues/WEB-1/comments', { body: 'A comment' });
    const proj = (await bob.client.get('/api/projects/WEB')).body.project;
    const done = proj.statuses.find((s) => s.name === 'Done');
    await bob.client.patch('/api/issues/WEB-1', { statusId: done.id });
    await flush();
    expect(pm.to('carol@example.com')).toHaveLength(0);

    const p = await carol.client.put('/api/me/email', { comment: true, status: true });
    expect(p.body.prefs).toEqual({ assigned: true, mentioned: true, comment: true, status: true });
    await bob.client.post('/api/issues/WEB-1/comments', { body: 'Another comment' });
    const todo = proj.statuses.find((s) => s.name === 'To Do');
    await bob.client.patch('/api/issues/WEB-1', { statusId: todo.id });
    await flush();
    const subjects = pm.to('carol@example.com').map((m) => m.Subject);
    expect(subjects).toEqual(['[WEB-1] Bob commented: Watch me', '[WEB-1] Bob moved it to To Do: Watch me']);
    expect(pm.to('carol@example.com')[1].TextBody).toContain('from Done to To Do');
  });

  it('respects turning assignments off and never emails deactivated users', async () => {
    await carol.client.put('/api/me/email', { assigned: false });
    await create(bob.client, { title: 'One', assigneeId: carol.id });
    await flush();
    expect(pm.to('carol@example.com')).toHaveLength(0);

    const dave = await addUser(ctx, { email: 'dave@example.com', name: 'Dave' });
    await ctx.admin.patch(`/api/admin/users/${dave.id}`, { status: 'deactivated' });
    await create(bob.client, { title: 'Two', description: `cc ${mention(dave, 'Dave')}` });
    await flush();
    expect(pm.to('dave@example.com')).toHaveLength(0);
  });

  it('preferences API: defaults, validation, configured flag', async () => {
    const g = await carol.client.get('/api/me/email');
    expect(g.body).toEqual({ configured: true, prefs: { assigned: true, mentioned: true, comment: false, status: false } });
    expect((await carol.client.put('/api/me/email', { comment: 'yes' })).status).toBe(400);
    await carol.client.put('/api/me/email', { mentioned: false });
    expect((await carol.client.get('/api/me/email')).body.prefs).toEqual({
      assigned: true,
      mentioned: false,
      comment: false,
      status: false,
    });
    expect((await bob.client.get('/api/me/email')).body.prefs.mentioned).toBe(true);
  });

  it('logs a failed send while the request still succeeds', async () => {
    pm.state.fail = true;
    const r = await create(bob.client, { title: 'Fails', assigneeId: carol.id });
    expect(r.status).toBe(201);
    await flush();
    expect(pm.sent).toHaveLength(1);
    const a = await ctx.admin.get('/api/admin/email');
    expect(a.body.errors).toHaveLength(1);
    expect(a.body.errors[0].error).toContain('Invalid email request');
    expect(a.body.errors[0].context).toContain('WEB-1');
  });
});

describe('email off', () => {
  beforeEach(() => setup({}));

  it('sends nothing without POSTMARK_SERVER_TOKEN and EMAIL_FROM', async () => {
    await create(bob.client, { title: 'Quiet', assigneeId: carol.id });
    await flush();
    expect(pm.sent).toHaveLength(0);
    expect((await carol.client.get('/api/me/email')).body.configured).toBe(false);
    expect((await ctx.admin.get('/api/admin/email')).body.configured).toBe(false);
    expect((await ctx.admin.post('/api/admin/email/test')).status).toBe(400);
    const u = await ctx.admin.post('/api/admin/users', { email: 'erin@example.com', name: 'Erin', sendEmail: true });
    expect(u.status).toBe(201);
    expect(u.body.user.inviteLink).toBeTruthy();
    expect(u.body.user.emailed).toBeUndefined();
    expect(pm.sent).toHaveLength(0);
  });
});

describe('invites and test email', () => {
  beforeEach(() => setup());

  it('emails invite and reset links when asked, and keeps the link', async () => {
    const list = await ctx.admin.get('/api/admin/users');
    expect(list.body.emailConfigured).toBe(true);
    const u = await ctx.admin.post('/api/admin/users', { email: 'erin@example.com', name: 'Erin', sendEmail: true });
    expect(u.body.user).toMatchObject({ emailed: true });
    const [inv] = pm.to('erin@example.com');
    expect(inv.Subject).toBe('You are invited to Opentrack');
    expect(inv.TextBody).toContain(u.body.user.inviteLink);

    const quiet = await ctx.admin.post('/api/admin/users', { email: 'finn@example.com', name: 'Finn' });
    expect(quiet.body.user.inviteLink).toBeTruthy();
    expect(pm.to('finn@example.com')).toHaveLength(0);

    const reset = await ctx.admin.post(`/api/admin/users/${carol.id}/invite`, { sendEmail: true });
    expect(reset.body).toMatchObject({ emailed: true });
    expect(reset.body.link).toBeTruthy();
    expect(pm.to('carol@example.com')[0].Subject).toBe('Reset your password for Opentrack');

    const bulk = await ctx.admin.post('/api/admin/users/bulk', {
      sendEmail: true,
      users: [
        { email: 'gus@example.com', name: 'Gus' },
        { email: 'hal@example.com', name: 'Hal' },
      ],
    });
    expect(bulk.body.results.every((r) => r.ok && r.user.emailed)).toBe(true);
    expect(pm.to('hal@example.com')).toHaveLength(1);

    pm.state.fail = true;
    const bad = await ctx.admin.post('/api/admin/users', { email: 'ivy@example.com', name: 'Ivy', sendEmail: true });
    expect(bad.status).toBe(201);
    expect(bad.body.user.emailed).toBe(false);
    expect(bad.body.user.inviteLink).toBeTruthy();
  });

  it('sends a test email to the admin only', async () => {
    const t = await ctx.admin.post('/api/admin/email/test');
    expect(t.status).toBe(200);
    expect(pm.to('admin@example.com')[0].Subject).toBe('Test email from Opentrack');
    expect((await bob.client.post('/api/admin/email/test')).status).toBe(403);
    pm.state.fail = true;
    expect((await ctx.admin.post('/api/admin/email/test')).status).toBe(502);
  });
});

describe('email text', () => {
  it('turns Markdown into readable text', () => {
    expect(plainText('## Title\n**bold** and *it* `code` [link](https://x.test) @[Ann](user:11111111-1111-1111-1111-111111111111)')).toBe(
      'Title\nbold and it code link (https://x.test) @Ann',
    );
  });

  it('escapes the HTML version', () => {
    const m = notificationEmail({
      type: 'comment',
      issue: { key: 'A-1', title: '<b>x</b>' },
      actorName: 'Eve & co',
      text: '<img src=x onerror=alert(1)>',
      origin: 'https://t.test',
    });
    expect(m.html).not.toContain('<b>x</b>');
    expect(m.html).not.toContain('<img');
    expect(m.html).toContain('Eve &amp; co');
  });
});
