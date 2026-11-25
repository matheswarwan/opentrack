import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser } from './helpers.js';
import { parseSlackLink } from '../server/routes/slack.js';
import { slackText } from '../server/lib/slack.js';

const TOKEN = 'xoxb-1111-2222-abcdefghijkl';

/** Fake Slack Web API: records calls, answers per method. `answers[method]` may be an object or a function(params). */
function fakeSlack() {
  const calls = [];
  const answers = {
    'auth.test': { ok: true, team: 'Acme', team_id: 'T1', url: 'https://acme.slack.com/', user: 'tracker', user_id: 'UBOT' },
    'users.lookupByEmail': (p) =>
      p.email === 'carol@example.com'
        ? { ok: true, user: { id: 'UCAROL' } }
        : p.email === 'bob@example.com'
          ? { ok: true, user: { id: 'UBOB' } }
          : { ok: false, error: 'users_not_found' },
    'conversations.open': (p) => ({ ok: true, channel: { id: `D${p.users}` } }),
    'chat.postMessage': () => ({ ok: true, ts: '1.2' }),
    'conversations.list': (p) =>
      !p.cursor
        ? {
            ok: true,
            channels: [
              { id: 'C0WEB1', name: 'web', is_private: false, is_member: false },
              { id: 'G1', name: 'secret', is_private: true, is_member: false },
            ],
            response_metadata: { next_cursor: 'next' },
          }
        : {
            ok: true,
            channels: [{ id: 'G2', name: 'team-private', is_private: true, is_member: true }],
            response_metadata: { next_cursor: '' },
          },
    'conversations.info': (p) => ({
      ok: true,
      channel: { id: p.channel, name: p.channel === 'G0PRIV9' ? 'private-room' : 'general', is_private: p.channel.startsWith('G') },
    }),
    'conversations.members': () => ({ ok: true, members: ['UBOB'] }),
    'conversations.history': (p) => ({
      ok: true,
      messages: [
        {
          ts: p.latest,
          user: 'UALICE',
          text: 'Login fails on Safari &amp; Firefox\nSteps: open <https://x.test|the page>, ask <@UBOB>',
          reply_count: 2,
        },
      ],
    }),
    'conversations.replies': (p) => ({
      ok: true,
      messages: [
        { ts: p.ts, user: 'UALICE', text: 'Parent message' },
        { ts: '1700000001.000200', user: 'UBOB', text: 'Same for me' },
        { ts: '1700000002.000300', user: 'UALICE', text: 'Thanks' },
      ],
    }),
    'users.info': (p) => ({ ok: true, user: { id: p.user, real_name: { UALICE: 'Alice Slack', UBOB: 'Bob Slack' }[p.user] || p.user } }),
  };
  async function fetch(url, init = {}) {
    const u = new URL(url);
    const method = u.pathname.replace('/api/', '');
    const params = init.body ? JSON.parse(init.body) : Object.fromEntries(u.searchParams);
    calls.push({ method, params, auth: init.headers?.authorization });
    const a = answers[method];
    const data = typeof a === 'function' ? a(params) : a || { ok: false, error: 'unknown_method' };
    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  }
  return { calls, answers, fetch, of: (m) => calls.filter((c) => c.method === m) };
}

let ctx, slack, bob, carol, queue;
async function flush() {
  while (queue.length) await Promise.all(queue.splice(0));
}
const create = (c, data) => c.post('/api/issues', { projectKey: 'WEB', ...data });

async function setup(extra = {}) {
  slack = fakeSlack();
  queue = [];
  ctx = await withAdmin({ fetch: slack.fetch, slackQueue: queue, PUBLIC_URL: 'https://tracker.example.com', ...extra });
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
  await bob.client.post('/api/projects', { key: 'web', name: 'Website' });
}

async function connect() {
  const r = await ctx.admin.put('/api/admin/slack', { token: TOKEN });
  expect(r.status).toBe(200);
  return r;
}

describe('admin token', () => {
  beforeEach(() => setup());

  it('tests, saves and removes the token without ever returning it', async () => {
    const t = await ctx.admin.post('/api/admin/slack/test', { token: TOKEN });
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ ok: true, team: 'Acme', botName: 'tracker' });
    expect(JSON.stringify(t.body)).not.toContain(TOKEN);
    expect(slack.of('auth.test')[0].auth).toBe(`Bearer ${TOKEN}`);

    expect((await ctx.admin.put('/api/admin/slack', { token: 'not-a-token' })).status).toBe(400);
    const s = await connect();
    expect(s.body).toMatchObject({ connected: true, source: 'db', tokenLast4: 'ijkl', team: 'Acme', botName: 'tracker', enabled: true });
    expect(JSON.stringify(s.body)).not.toContain(TOKEN);
    const g = await ctx.admin.get('/api/admin/slack');
    expect(JSON.stringify(g.body)).not.toContain(TOKEN);
    expect(g.body.scopes.map((x) => x.scope)).toContain('users:read.email');
    expect((await bob.client.get('/api/slack/status')).body).toMatchObject({ connected: true, dm: true });

    // the audit log never holds the token
    const audit = await ctx.admin.get('/api/admin/audit');
    expect(JSON.stringify(audit.body)).not.toContain(TOKEN);

    const d = await ctx.admin.del('/api/admin/slack');
    expect(d.body).toMatchObject({ connected: false, tokenLast4: null });
    expect((await bob.client.get('/api/slack/status')).body.connected).toBe(false);
  });

  it('rejects a token Slack refuses and explains it', async () => {
    slack.answers['auth.test'] = { ok: false, error: 'invalid_auth' };
    const r = await ctx.admin.put('/api/admin/slack', { token: TOKEN });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/token does not work/);
    expect((await ctx.admin.get('/api/admin/slack')).body.connected).toBe(false);
  });

  it('only admins manage the token', async () => {
    expect((await bob.client.get('/api/admin/slack')).status).toBe(403);
    expect((await bob.client.put('/api/admin/slack', { token: TOKEN })).status).toBe(403);
    expect((await bob.client.post('/api/admin/slack/test', { token: TOKEN })).status).toBe(403);
    expect((await bob.client.del('/api/admin/slack')).status).toBe(403);
    expect((await bob.client.patch('/api/admin/slack', { enabled: false })).status).toBe(403);
  });

  it('can be turned off without removing the token', async () => {
    await connect();
    const off = await ctx.admin.patch('/api/admin/slack', { enabled: false });
    expect(off.body).toMatchObject({ connected: true, enabled: false, tokenLast4: 'ijkl' });
    expect((await bob.client.get('/api/slack/status')).body.connected).toBe(false);
    await bob.client
      .put('/api/projects/WEB/slack', { channelId: 'C0WEB1', channelName: 'web', events: ['issue_created'] })
      .then((r) => expect(r.status).toBe(409));
    await create(bob.client, { title: 'Quiet', assigneeId: carol.id });
    await flush();
    expect(slack.of('chat.postMessage')).toHaveLength(0);
    const on = await ctx.admin.patch('/api/admin/slack', { enabled: true });
    expect(on.body).toMatchObject({ enabled: true, tokenLast4: 'ijkl' });
  });
});

describe('server token', () => {
  it('SLACK_BOT_TOKEN wins and cannot be changed in the UI', async () => {
    await setup({ SLACK_BOT_TOKEN: 'xoxb-env-token-9999' });
    const g = await ctx.admin.get('/api/admin/slack');
    expect(g.body).toMatchObject({ connected: true, source: 'env', managedOnServer: true, tokenLast4: '9999' });
    expect(JSON.stringify(g.body)).not.toContain('xoxb-env');
    expect((await ctx.admin.put('/api/admin/slack', { token: TOKEN })).status).toBe(409);
    expect((await ctx.admin.del('/api/admin/slack')).status).toBe(409);
    // still usable and can be turned off
    await bob.client.put('/api/projects/WEB/slack', { channelId: 'C0WEB1', channelName: 'web', events: ['issue_created'] });
    await create(bob.client, { title: 'Env token' });
    await flush();
    expect(slack.of('chat.postMessage')[0].auth).toBe('Bearer xoxb-env-token-9999');
    await ctx.admin.patch('/api/admin/slack', { enabled: false });
    expect((await ctx.admin.get('/api/admin/slack')).body).toMatchObject({ source: 'env', enabled: false });
  });
});

describe('project channel', () => {
  beforeEach(async () => {
    await setup();
    await connect();
  });

  it('lists channels the bot can post to, paginated and cached', async () => {
    const r = await bob.client.get('/api/projects/WEB/slack/channels');
    expect(r.status).toBe(200);
    expect(r.body.channels.map((c) => c.name)).toEqual(['team-private', 'web']);
    expect(slack.of('conversations.list')).toHaveLength(2);
    await bob.client.get('/api/projects/WEB/slack/channels');
    expect(slack.of('conversations.list')).toHaveLength(2); // cached
  });

  it('only project admins set the channel', async () => {
    expect((await carol.client.get('/api/projects/WEB/slack')).status).toBe(403);
    expect((await carol.client.get('/api/projects/WEB/slack/channels')).status).toBe(403);
    expect((await carol.client.put('/api/projects/WEB/slack', { channelId: 'C0WEB1' })).status).toBe(403);
    expect((await bob.client.put('/api/projects/WEB/slack', { channelId: 'nope' })).status).toBe(400);
    const ok = await bob.client.put('/api/projects/WEB/slack', {
      channelId: 'C0WEB1',
      channelName: 'web',
      events: ['issue_created', 'bogus'],
    });
    expect(ok.body).toEqual({ channel: { id: 'C0WEB1', name: 'web' }, events: ['issue_created'] });
    expect((await bob.client.get('/api/projects/WEB/slack')).body).toMatchObject({
      connected: true,
      channel: { id: 'C0WEB1' },
      events: ['issue_created'],
    });
    // workspace admins can too
    expect((await ctx.admin.put('/api/projects/WEB/slack', { channelId: null })).body.channel).toBe(null);
  });

  it('posts each event when turned on for the project', async () => {
    const all = ['issue_created', 'status_changed', 'assignee_changed', 'comment_added', 'sprint_started', 'sprint_completed'];
    await bob.client.put('/api/projects/WEB/slack', { channelId: 'C0WEB1', channelName: 'web', events: all });
    const posts = () => slack.of('chat.postMessage').filter((c) => c.params.channel === 'C0WEB1');

    const i = (await create(bob.client, { title: 'Fix <login> & more' })).body.issue;
    await flush();
    expect(posts()).toHaveLength(1);
    const text = posts()[0].params.blocks[0].text.text;
    expect(text).toContain('<https://tracker.example.com/browse/WEB-1|WEB-1>');
    expect(text).toContain('Fix &lt;login&gt; &amp; more');
    expect(text).toContain('Bob created a task. Status: To Do. Assignee: Unassigned');

    const proj = (await bob.client.get('/api/projects/WEB')).body.project;
    const inProgress = proj.statuses.find((s) => s.name === 'In Progress');
    await bob.client.patch(`/api/issues/${i.key}`, { statusId: inProgress.id, assigneeId: carol.id });
    await flush();
    const upd = posts()[1].params.blocks[0].text.text;
    expect(upd).toContain('Bob moved it from To Do to *In Progress*');
    expect(upd).toContain('Bob assigned it to *Carol*');

    await bob.client.post(`/api/issues/${i.key}/comments`, { body: `Over to you @[Carol](user:${carol.id})` });
    await flush();
    const cm = posts()[2].params.blocks[0].text.text;
    expect(cm).toContain('Bob commented:');
    expect(cm).toContain('>Over to you @Carol');

    const sp = (await bob.client.post('/api/projects/WEB/sprints', { goal: 'Ship login' })).body.sprint;
    await bob.client.post(`/api/sprints/${sp.id}/start`, {});
    await flush();
    expect(posts()[3].params.blocks[0].text.text).toMatch(
      /Bob started \*.+\* in Website \(\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}\)\nGoal: Ship login/,
    );
    await bob.client.patch(`/api/issues/${i.key}`, { sprintId: sp.id });
    await bob.client.post(`/api/sprints/${sp.id}/complete`, {});
    await flush();
    expect(posts()[4].params.blocks[0].text.text).toContain('1 unfinished issue moved to the backlog');
    expect(posts()).toHaveLength(5);
  });

  it('skips events the project turned off', async () => {
    await bob.client.put('/api/projects/WEB/slack', { channelId: 'C0WEB1', channelName: 'web', events: ['comment_added'] });
    const i = (await create(bob.client, { title: 'Quiet one' })).body.issue;
    const proj = (await bob.client.get('/api/projects/WEB')).body.project;
    await bob.client.patch(`/api/issues/${i.key}`, { statusId: proj.statuses[1].id });
    await flush();
    expect(slack.of('chat.postMessage')).toHaveLength(0);
    await bob.client.post(`/api/issues/${i.key}/comments`, { body: 'Now' });
    await flush();
    expect(slack.of('chat.postMessage')).toHaveLength(1);
  });

  it('logs Slack failures and the request still succeeds', async () => {
    await bob.client.put('/api/projects/WEB/slack', { channelId: 'C0WEB1', channelName: 'web', events: ['issue_created'] });
    slack.answers['chat.postMessage'] = { ok: false, error: 'not_in_channel' };
    const r = await create(bob.client, { title: 'Still created' });
    expect(r.status).toBe(201);
    await flush();
    const g = await ctx.admin.get('/api/admin/slack');
    expect(g.body.errors[0]).toMatchObject({ method: 'chat.postMessage', error: 'not_in_channel' });
    expect(g.body.errors[0].context).toContain('#web');
    expect(g.body.errors[0].explanation).toMatch(/invite @tracker/);

    // a thrown network error is also caught
    slack.answers['chat.postMessage'] = () => {
      throw new Error('boom');
    };
    expect((await create(bob.client, { title: 'Again' })).status).toBe(201);
    await flush();
    expect((await ctx.admin.get('/api/admin/slack')).body.errors[0].error).toBe('network_error');
  });

  it('keeps only the last 50 errors', async () => {
    await bob.client.put('/api/projects/WEB/slack', { channelId: 'C0WEB1', channelName: 'web', events: ['issue_created'] });
    slack.answers['chat.postMessage'] = { ok: false, error: 'not_in_channel' };
    for (let n = 0; n < 53; n++) await create(bob.client, { title: `n${n}` });
    await flush();
    const row = await ctx.db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM slack_errors');
    expect(row.n).toBe(50);
  });
});

describe('personal DMs', () => {
  beforeEach(async () => {
    await setup();
    await connect();
  });
  const dms = () => slack.of('chat.postMessage').filter((c) => c.params.channel.startsWith('D'));

  it('DMs on assignment and mention, looks people up once by email', async () => {
    const i = (await create(bob.client, { title: 'Assigned', assigneeId: carol.id })).body.issue;
    await flush();
    expect(dms()).toHaveLength(1);
    expect(dms()[0].params.channel).toBe('DUCAROL');
    expect(dms()[0].params.blocks[0].text.text).toContain('Bob assigned <https://tracker.example.com/browse/WEB-1|WEB-1> to you: Assigned');

    await bob.client.post(`/api/issues/${i.key}/comments`, { body: `ping @[Carol](user:${carol.id})` });
    await flush();
    expect(dms()).toHaveLength(2);
    expect(dms()[1].params.blocks[0].text.text).toContain('Bob mentioned you in');
    expect(dms()[1].params.blocks[0].text.text).toContain('>ping @Carol');
    expect(slack.of('users.lookupByEmail')).toHaveLength(1); // cached

    // a self-mention is a reminder: it DMs the author too
    await carol.client.post(`/api/issues/${i.key}/comments`, { body: `self @[Carol](user:${carol.id})` });
    await flush();
    expect(dms()).toHaveLength(3);
    expect(dms()[2].params.channel).toBe('DUCAROL');

    // plain comments (no mention) send no DM
    await bob.client.post(`/api/issues/${i.key}/comments`, { body: 'no mention' });
    await flush();
    expect(dms()).toHaveLength(3);
  });

  it('respects the profile opt-out', async () => {
    expect((await carol.client.put('/api/me/slack', { dm: false })).body).toEqual({ dm: false });
    expect((await carol.client.get('/api/slack/status')).body.dm).toBe(false);
    await create(bob.client, { title: 'x', assigneeId: carol.id });
    await flush();
    expect(dms()).toHaveLength(0);
    await carol.client.put('/api/me/slack', { dm: true });
    await create(bob.client, { title: 'y', assigneeId: carol.id });
    await flush();
    expect(dms()).toHaveLength(1);
  });

  it('caches a not-found email and does not log it as an error', async () => {
    const dave = await addUser(ctx, { email: 'dave@example.com', name: 'Dave' });
    await create(bob.client, { title: 'a', assigneeId: dave.id });
    await create(bob.client, { title: 'b', assigneeId: dave.id });
    await flush();
    expect(dms()).toHaveLength(0);
    expect(slack.of('users.lookupByEmail')).toHaveLength(1);
    expect((await ctx.admin.get('/api/admin/slack')).body.errors).toHaveLength(0);
  });

  it('DMs newly mentioned people when a description changes', async () => {
    const i = (await create(bob.client, { title: 'Desc' })).body.issue;
    await bob.client.patch(`/api/issues/${i.key}`, { description: `cc @[Carol](user:${carol.id})` });
    await flush();
    expect(dms()).toHaveLength(1);
    await bob.client.patch(`/api/issues/${i.key}`, { description: `cc @[Carol](user:${carol.id}) again` });
    await flush();
    expect(dms()).toHaveLength(1);
  });
});

describe('create an issue from a Slack message', () => {
  beforeEach(async () => {
    await setup();
    await connect();
  });

  it('parses message links', () => {
    expect(parseSlackLink('https://acme.slack.com/archives/C0123ABC/p1700000000123456')).toMatchObject({
      channel: 'C0123ABC',
      ts: '1700000000.123456',
      threadTs: null,
    });
    expect(
      parseSlackLink('https://acme.slack.com/archives/C0123ABC/p1700000001000200?thread_ts=1700000000.123456&cid=C0123ABC'),
    ).toMatchObject({ ts: '1700000001.000200', threadTs: '1700000000.123456' });
    expect(parseSlackLink('https://evil.example.com/archives/C0123ABC/p1700000000123456')).toBe(null);
    expect(parseSlackLink('http://acme.slack.com/archives/C0123ABC/p1700000000123456')).toBe(null);
    expect(parseSlackLink('nope')).toBe(null);
  });

  it('imports a channel message with its thread', async () => {
    const r = await bob.client.post('/api/slack/message', { url: 'https://acme.slack.com/archives/C0123ABC/p1700000000123456' });
    expect(r.status).toBe(200);
    expect(r.body.author).toBe('Alice Slack');
    expect(r.body.text).toBe('Login fails on Safari & Firefox\nSteps: open the page (https://x.test), ask @Bob Slack');
    expect(r.body.permalink).toBe('https://acme.slack.com/archives/C0123ABC/p1700000000123456');
    expect(r.body.replies.map((x) => x.author)).toEqual(['Bob Slack', 'Alice Slack']);
    expect(slack.of('conversations.history')[0].params).toMatchObject({
      channel: 'C0123ABC',
      latest: '1700000000.123456',
      inclusive: 'true',
      limit: '1',
    });
  });

  it('imports a reply from a thread link', async () => {
    const r = await bob.client.post('/api/slack/message', {
      url: 'https://acme.slack.com/archives/C0123ABC/p1700000001000200?thread_ts=1700000000.123456',
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ author: 'Bob Slack', text: 'Same for me' });
    expect(r.body.replies.map((x) => x.text)).toEqual(['Thanks']);
    expect(slack.of('conversations.replies')[0].params.ts).toBe('1700000000.123456');
  });

  it('explains not_in_channel in plain words', async () => {
    slack.answers['conversations.history'] = { ok: false, error: 'not_in_channel' };
    const r = await bob.client.post('/api/slack/message', { url: 'https://acme.slack.com/archives/C0123ABC/p1700000000123456' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe(
      'The Slack app is not in that channel. In Slack, open the channel and type /invite @tracker, then try again.',
    );
    expect(r.body.slackError).toBe('not_in_channel');
  });

  it('private channels need the person to be in the channel on Slack', async () => {
    const url = 'https://acme.slack.com/archives/G0PRIV9/p1700000000123456';
    expect((await bob.client.post('/api/slack/message', { url })).status).toBe(200); // UBOB is a member
    const c = await carol.client.post('/api/slack/message', { url });
    expect(c.status).toBe(403);
    expect(c.body.error).toMatch(/private channel you are not in/);
  });

  it('refuses bad links, DMs, and use when Slack is off', async () => {
    expect((await bob.client.post('/api/slack/message', { url: 'https://example.com' })).status).toBe(400);
    expect(
      (await bob.client.post('/api/slack/message', { url: 'https://acme.slack.com/archives/D0123ABC/p1700000000123456' })).status,
    ).toBe(400);
    await ctx.admin.patch('/api/admin/slack', { enabled: false });
    expect(
      (await bob.client.post('/api/slack/message', { url: 'https://acme.slack.com/archives/C0123ABC/p1700000000123456' })).status,
    ).toBe(409);
  });
});

describe('text', () => {
  it('renders mentions and escapes mrkdwn', () => {
    expect(slackText('hi @[Carol Smith](user:12345678-1234-1234-1234-123456789012) <b> & co')).toBe('hi @Carol Smith &lt;b&gt; &amp; co');
  });
});
