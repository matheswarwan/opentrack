import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { withAdmin, addUser } from './helpers.js';

const TOKEN = 'xoxb-1111-2222-abcdefghijkl';
const SECRET = '8f742231b10e8888abcd99yyyzzz85a5';

/** Fake Slack: Web API methods plus response_url posts. */
function fakeSlack() {
  const calls = [];
  const emails = { UBOB: 'Bob@Example.com', UCAROL: 'carol@example.com', UVIC: 'vic@example.com', UNOBODY: 'nobody@example.com' };
  const answers = {
    'auth.test': { ok: true, team: 'Acme', team_id: 'T1', url: 'https://acme.slack.com/', user: 'tracker', user_id: 'UBOT' },
    'users.info': (p) =>
      emails[p.user] ? { ok: true, user: { id: p.user, profile: { email: emails[p.user] } } } : { ok: false, error: 'user_not_found' },
    'users.lookupByEmail': { ok: false, error: 'users_not_found' },
    'views.open': () => ({ ok: true, view: { id: 'V1' } }),
    'chat.postEphemeral': () => ({ ok: true }),
    'chat.postMessage': () => ({ ok: true, ts: '1.2' }),
    'chat.getPermalink': (p) => ({
      ok: true,
      permalink: `https://acme.slack.com/archives/${p.channel}/p${p.message_ts.replace('.', '')}`,
    }),
  };
  async function fetch(url, init = {}) {
    const u = new URL(url);
    if (u.hostname === 'hooks.slack.com') {
      calls.push({ method: 'response_url', url, params: JSON.parse(init.body) });
      return new Response('ok');
    }
    const method = u.pathname.replace('/api/', '');
    const params = init.body ? JSON.parse(init.body) : Object.fromEntries(u.searchParams);
    calls.push({ method, params, auth: init.headers?.authorization });
    const a = answers[method];
    const data = typeof a === 'function' ? a(params) : a || { ok: false, error: 'unknown_method' };
    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  }
  return { calls, answers, fetch, of: (m) => calls.filter((c) => c.method === m) };
}

let ctx, slack, queue, bob, carol;
async function flush() {
  while (queue.length) await Promise.all(queue.splice(0));
}

async function setup({ secretEnv = true, connect = true } = {}) {
  slack = fakeSlack();
  queue = [];
  ctx = await withAdmin({
    fetch: slack.fetch,
    slackQueue: queue,
    PUBLIC_URL: 'https://tracker.example.com',
    ...(secretEnv ? { SLACK_SIGNING_SECRET: SECRET } : {}),
  });
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
  await addUser(ctx, { email: 'vic@example.com', name: 'Vic', role: 'viewer' });
  await bob.client.post('/api/projects', { key: 'web', name: 'Website' });
  await bob.client.post('/api/projects', { key: 'sec', name: 'Secret', visibility: 'private' });
  if (connect) expect((await ctx.admin.put('/api/admin/slack', { token: TOKEN })).status).toBe(200);
}

function signedRequest(path, raw, { ts = Math.floor(Date.now() / 1000), secret = SECRET, sig } = {}) {
  const signature = sig ?? `v0=${createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex')}`;
  return ctx.app.request(
    path,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': String(ts),
        'x-slack-signature': signature,
      },
      body: raw,
    },
    ctx.env,
  );
}

async function command(text, { user = 'UBOB', team = 'T1', ...opts } = {}) {
  const raw = new URLSearchParams({
    token: 'legacy',
    team_id: team,
    user_id: user,
    command: '/tracker',
    text,
    response_url: 'https://hooks.slack.com/commands/1/2/3',
    trigger_id: 't1',
  }).toString();
  const res = await signedRequest('/slack/commands', raw, opts);
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
}

async function interact(payload, opts) {
  const raw = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const res = await signedRequest('/slack/interactivity', raw, opts);
  const text = await res.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const shortcut = (
  user = 'UBOB',
  message = { ts: '1700000000.000100', user: 'UALICE', text: 'Checkout fails on Safari\nSteps: open <https://x.test|the page>' },
) => ({
  type: 'message_action',
  callback_id: 'create_issue',
  trigger_id: 'trig-1',
  team: { id: 'T1' },
  user: { id: user },
  channel: { id: 'C0GENERAL' },
  message,
  response_url: 'https://hooks.slack.com/actions/1/2/3',
});

const submission = (values, user = 'UBOB', meta = { channel: 'C0GENERAL', ts: '1700000000.000100' }) => ({
  type: 'view_submission',
  team: { id: 'T1' },
  user: { id: user },
  view: {
    callback_id: 'tracker_create_issue',
    private_metadata: JSON.stringify(meta),
    state: {
      values: {
        project: { value: { selected_option: values.project ? { value: values.project } : null } },
        type: { value: { selected_option: { value: values.type || 'task' } } },
        title: { value: { value: values.title ?? 'Checkout fails on Safari' } },
        description: { value: { value: values.description ?? 'Checkout fails on Safari' } },
      },
    },
  },
});

describe('signature', () => {
  it('needs a signing secret, a fresh timestamp and a good signature', async () => {
    await setup({ secretEnv: false });
    expect((await command('help')).status).toBe(503);
    // saved under Admin > Slack, never returned
    expect((await bob.client.put('/api/admin/slack/signing-secret', { secret: SECRET })).status).toBe(403);
    expect((await ctx.admin.put('/api/admin/slack/signing-secret', { secret: 'xoxb-not-it' })).status).toBe(400);
    const saved = await ctx.admin.put('/api/admin/slack/signing-secret', { secret: SECRET });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      signingSecretSet: true,
      signingSecretOnServer: false,
      commandsUrl: 'https://tracker.example.com/slack/commands',
      interactivityUrl: 'https://tracker.example.com/slack/interactivity',
    });
    expect(JSON.stringify(saved.body)).not.toContain(SECRET);
    expect(JSON.stringify((await ctx.admin.get('/api/admin/slack')).body)).not.toContain(SECRET);
    // turning Slack off and on, or saving the token again, keeps it
    await ctx.admin.patch('/api/admin/slack', { enabled: false });
    await ctx.admin.patch('/api/admin/slack', { enabled: true });
    await ctx.admin.put('/api/admin/slack', { token: TOKEN });
    expect((await ctx.admin.get('/api/admin/slack')).body.signingSecretSet).toBe(true);

    expect((await command('help')).status).toBe(200);
    expect((await command('help', { ts: Math.floor(Date.now() / 1000) - 301 })).status).toBe(401);
    expect((await command('help', { ts: Math.floor(Date.now() / 1000) + 400 })).status).toBe(401);
    expect((await command('help', { ts: 'abc' })).status).toBe(401);
    expect((await command('help', { secret: 'wrong-secret' })).status).toBe(401);
    expect((await command('help', { sig: '' })).status).toBe(401);
    expect((await interact(shortcut(), { secret: 'wrong-secret' })).status).toBe(401);
    expect(slack.of('views.open')).toHaveLength(0);

    // the backup never holds it
    const b = await ctx.admin.get('/api/admin/backup');
    expect(JSON.stringify(b.body)).not.toContain(SECRET);

    expect((await ctx.admin.del('/api/admin/slack/signing-secret')).body.signingSecretSet).toBe(false);
    expect((await command('help')).status).toBe(503);
  });

  it('prefers SLACK_SIGNING_SECRET and cannot change it from the app', async () => {
    await setup();
    const s = (await ctx.admin.get('/api/admin/slack')).body;
    expect(s).toMatchObject({ signingSecretSet: true, signingSecretOnServer: true });
    expect((await ctx.admin.put('/api/admin/slack/signing-secret', { secret: 'abcdef0123456789abcdef' })).status).toBe(409);
    // turning Slack off does not copy the server's secret into the database
    await ctx.admin.patch('/api/admin/slack', { enabled: false });
    expect((await ctx.db.get(`SELECT config FROM integrations WHERE key = 'slack'`)).config).not.toContain(SECRET);
  });
});

describe('/tracker command', () => {
  beforeEach(() => setup());

  it('answers help, and refuses when Slack is not connected or the workspace is another one', async () => {
    const h = await command('');
    expect(h.status).toBe(200);
    expect(h.body.response_type).toBe('ephemeral');
    expect(h.body.text).toMatch(/\/tracker create WEB/);
    expect((await command('help')).body.text).toMatch(/\/tracker mine/);
    expect((await command('dance')).body.text).toMatch(/did not understand/);
    expect((await command('help', { team: 'T999' })).body.text).toMatch(/not the one connected/);
    await ctx.admin.patch('/api/admin/slack', { enabled: false });
    expect((await command('help')).body.text).toMatch(/not connected to Slack/);
  });

  it('matches the Slack user by email and refuses people with no account', async () => {
    const r = await command('mine', { user: 'UNOBODY' });
    expect(r.body.text).toMatch(/does not match an active account/);
    expect((await command('mine', { user: 'UNKNOWN1' })).body.text).toMatch(/does not match/);
    await command('mine');
    await command('mine');
    expect(slack.of('users.info').filter((c) => c.params.user === 'UBOB')).toHaveLength(1); // cached after the first time
    expect(await ctx.db.get('SELECT slack_user_id FROM slack_users WHERE user_id = ?', [bob.id])).toMatchObject({ slack_user_id: 'UBOB' });
    // deactivated people are refused even when cached
    await command('mine', { user: 'UCAROL' });
    expect((await ctx.admin.patch(`/api/admin/users/${carol.id}`, { status: 'deactivated' })).status).toBe(200);
    expect((await command('mine', { user: 'UCAROL' })).body.text).toMatch(/does not match/);
  });

  it('creates an issue as the Slack user, with their rights', async () => {
    const r = await command('create web Fix the login page');
    expect(r.body.text).toMatch(/^Created <https:\/\/tracker\.example\.com\/browse\/WEB-1\|WEB-1> Fix the login page in Website\.$/);
    const i = await ctx.db.get(
      `SELECT i.title, i.type, u.name AS reporter FROM issues i JOIN users u ON u.id = i.reporter_id WHERE i.key = 'WEB-1'`,
    );
    expect(i).toMatchObject({ title: 'Fix the login page', type: 'task', reporter: 'Bob' });
    expect((await command('create WEB bug: Checkout crashes')).body.text).toMatch(/WEB-2/);
    expect(await ctx.db.get(`SELECT type, title FROM issues WHERE key = 'WEB-2'`)).toMatchObject({
      type: 'bug',
      title: 'Checkout crashes',
    });

    expect((await command('create WEB')).body.text).toMatch(/Write it like this/);
    // a private project Carol is not in: not found
    expect((await command('create SEC Peek', { user: 'UCAROL' })).body.text).toMatch(/Project SEC was not found, or you cannot see it/);
    expect((await command('create NOPE Thing')).body.text).toMatch(/not found/);
    // a viewer cannot create
    const v = await command('create WEB Viewer issue', { user: 'UVIC' });
    expect(v.body.text).toMatch(/^Could not create the issue:/);
    expect(await ctx.db.get(`SELECT id FROM issues WHERE title = 'Viewer issue'`)).toBe(null);
  });

  it('shows an issue only to people who can see it, and lists their open issues', async () => {
    await bob.client.post('/api/issues', { projectKey: 'WEB', title: 'Public one', assigneeId: bob.id, priority: 'high' });
    await bob.client.post('/api/issues', { projectKey: 'SEC', title: 'Hidden one', assigneeId: bob.id });
    const s = await command('web-1');
    expect(s.body.text).toMatch(/\*<https:\/\/tracker\.example\.com\/browse\/WEB-1\|WEB-1>\* Public one/);
    expect(s.body.text).toMatch(/Status: To Do\. Priority: high\. Assignee: Bob\./);
    expect((await command('SEC-1', { user: 'UCAROL' })).body.text).toBe('SEC-1 was not found, or you cannot see it.');
    expect((await command('SEC-1')).body.text).toMatch(/Hidden one/);
    expect((await command('WEB-99')).body.text).toMatch(/not found/);

    const m = await command('mine');
    expect(m.body.text).toMatch(/Your open issues/);
    expect(m.body.text).toMatch(/WEB-1/);
    expect(m.body.text).toMatch(/SEC-1/);
    expect((await command('mine', { user: 'UCAROL' })).body.text).toBe('You have no open issues.');
  });

  it('answers without a bot token configured', async () => {
    await ctx.admin.del('/api/admin/slack');
    const r = await command('help');
    expect(r.status).toBe(200);
    expect(r.body.text).toMatch(/not connected to Slack/);
  });
});

describe('message shortcut', () => {
  beforeEach(() => setup());

  it('opens a window with the projects the person can create in and the message prefilled', async () => {
    await ctx.admin.post('/api/projects', { key: 'ADM', name: 'Admin only', visibility: 'private' });
    const r = await interact(shortcut());
    expect(r.status).toBe(200);
    const open = slack.of('views.open');
    expect(open).toHaveLength(1);
    expect(open[0].auth).toBe(`Bearer ${TOKEN}`);
    const v = open[0].params.view;
    expect(open[0].params.trigger_id).toBe('trig-1');
    expect(v.callback_id).toBe('tracker_create_issue');
    const blocks = Object.fromEntries(v.blocks.map((b) => [b.block_id, b.element]));
    expect(blocks.project.options.map((o) => o.value).sort()).toEqual(['SEC', 'WEB']); // not ADM
    expect(blocks.title.initial_value).toBe('Checkout fails on Safari');
    expect(blocks.description.initial_value).toBe('Checkout fails on Safari\nSteps: open the page (https://x.test)');
    expect(JSON.parse(v.private_metadata)).toEqual({ channel: 'C0GENERAL', ts: '1700000000.000100' });

    await interact(shortcut('UCAROL'));
    const carolView = slack.of('views.open')[1].params.view;
    expect(carolView.blocks[0].element.options.map((o) => o.value)).toEqual(['WEB']);
  });

  it('tells people with no account or no project through the response URL', async () => {
    await interact(shortcut('UNOBODY'));
    await interact(shortcut('UVIC'));
    await flush();
    const said = slack.of('response_url').map((c) => c.params);
    expect(said).toHaveLength(2);
    expect(said[0]).toMatchObject({ response_type: 'ephemeral' });
    expect(said[0].text).toMatch(/does not match/);
    expect(said[1].text).toMatch(/cannot create issues in any project/);
    expect(slack.of('views.open')).toHaveLength(0);
  });

  it('creates the issue on submit with a link to the message, and confirms in Slack', async () => {
    const r = await interact(
      submission({
        project: 'WEB',
        type: 'bug',
        title: 'Checkout fails on Safari',
        description: 'Checkout fails on Safari\nSteps: open the page',
      }),
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ response_action: 'clear' });
    const i = await ctx.db.get(
      `SELECT i.key, i.type, i.title, i.description, u.name AS reporter FROM issues i JOIN users u ON u.id = i.reporter_id WHERE i.key = 'WEB-1'`,
    );
    expect(i).toMatchObject({ type: 'bug', title: 'Checkout fails on Safari', reporter: 'Bob' });
    expect(i.description).toBe(
      'Checkout fails on Safari\nSteps: open the page\n\nFrom Slack: https://acme.slack.com/archives/C0GENERAL/p1700000000000100',
    );
    await flush();
    const eph = slack.of('chat.postEphemeral');
    expect(eph).toHaveLength(1);
    expect(eph[0].params).toMatchObject({ channel: 'C0GENERAL', user: 'UBOB' });
    expect(eph[0].params.text).toMatch(/Created <https:\/\/tracker\.example\.com\/browse\/WEB-1\|WEB-1>/);
  });

  it('falls back to a direct message when the ephemeral confirmation fails', async () => {
    slack.answers['chat.postEphemeral'] = { ok: false, error: 'channel_not_found' };
    await interact(submission({ project: 'WEB' }));
    await flush();
    const dm = slack.of('chat.postMessage');
    expect(dm).toHaveLength(1);
    expect(dm[0].params.channel).toBe('UBOB');
  });

  it('shows errors in the window instead of creating', async () => {
    let r = await interact(submission({ project: 'SEC' }, 'UCAROL'));
    expect(r.body).toMatchObject({ response_action: 'errors', errors: { project: 'Project not found, or you cannot see it' } });
    r = await interact(submission({ project: 'WEB' }, 'UVIC'));
    expect(r.body.response_action).toBe('errors');
    r = await interact(submission({ project: 'WEB', title: '' }));
    expect(r.body).toMatchObject({ response_action: 'errors', errors: { title: 'Enter a title' } });
    r = await interact(submission({ project: '' }));
    expect(r.body.errors.project).toBe('Choose a project');
    r = await interact(submission({ project: 'WEB' }, 'UNOBODY'));
    expect(r.body.errors.project).toMatch(/does not match/);
    expect(await ctx.db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM issues')).toMatchObject({ n: 0 });
  });

  it('refuses when no bot token is configured', async () => {
    await ctx.admin.del('/api/admin/slack');
    const r = await interact(submission({ project: 'WEB' }));
    expect(r.body).toMatchObject({ response_action: 'errors' });
    expect(r.body.errors.project).toMatch(/not connected to Slack/);
    await interact(shortcut());
    await flush();
    expect(slack.of('response_url')[0].params.text).toMatch(/not connected to Slack/);
  });
});
