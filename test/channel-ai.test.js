import { describe, it, expect, beforeEach } from 'vitest';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { withAdmin, addUser, PASSWORD } from './helpers.js';
import { runDueJobs } from '../server/lib/jobs.js';
import { aiComplete, resetAiTokens, AiError } from '../server/lib/ai.js';
import { resetSlackNames, AI_SCHEMA, AI_EMAIL } from '../server/lib/channelAi.js';
import { BACKUP_SCHEMA } from '../server/lib/backup.js';

const TOKEN = 'xoxb-1111-2222-abcdefghijkl';
const T0 = Date.parse('2026-11-19T16:00:00Z');
const ts = (min) => `${Math.floor(T0 / 1000) - 3600 + min * 60}.000100`; // messages an hour before T0, a minute apart

/** Fake Slack Web API (answers per method; `answers[method]` may be a function of the params). */
function fakeSlack() {
  const calls = [];
  const answers = {
    'auth.test': { ok: true, team: 'Acme', team_id: 'T1', url: 'https://acme.slack.com/', user: 'tracker', user_id: 'UBOT' },
    'conversations.history': { ok: true, messages: [] },
    'conversations.replies': { ok: true, messages: [] },
    'users.info': (p) => ({ ok: true, user: { id: p.user, real_name: { UDANA: 'Dana Client', URAJ: 'Raj Dev' }[p.user] || p.user } }),
  };
  async function fetch(url, init = {}) {
    const u = new URL(url);
    const method = u.pathname.replace('/api/', '');
    const params = init.body ? JSON.parse(init.body) : Object.fromEntries(u.searchParams);
    calls.push({ method, params });
    const a = answers[method];
    const data = typeof a === 'function' ? a(params) : a || { ok: false, error: 'unknown_method' };
    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  }
  return { calls, answers, fetch, of: (m) => calls.filter((c) => c.method === m) };
}

/** Fake AI provider: records requests, answers with `answer` (JSON) or `status`. */
function fakeAi() {
  const calls = [];
  const state = { status: 200, answer: null, statuses: [] };
  async function fetch(url, init = {}) {
    const body = typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init.body;
    const headers = init.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : init.headers;
    calls.push({ url: String(url), headers, body });
    const status = state.statuses.length ? state.statuses.shift() : state.status;
    url = String(url);
    if (url.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'ya29.test-token', expires_in: 3600 });
    if (status !== 200)
      return Response.json({ error: { code: status, status: 'INTERNAL', message: 'secret details that must not be logged' } }, { status });
    const text = JSON.stringify(state.answer);
    if (url.startsWith('https://api.anthropic.com/')) return Response.json({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });
    return Response.json({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });
  }
  return { calls, state, fetch };
}

const ANSWER = {
  summary: 'Dana approved the new login page. Raj starts today.',
  decisions: ['Scope: login page only'],
  risks: ['SSO is not ready yet'],
  suggestions: [
    { kind: 'status', value: 'In Progress', reason: 'Raj started' },
    { kind: 'status', value: 'Nope', reason: 'not a status' },
    { kind: 'assignee', value: 'Carol', reason: 'Carol takes QA' },
    { kind: 'dueDate', value: '2026-12-01', reason: 'Dana asked for 1 Dec' },
    { kind: 'priority', value: 'high', reason: 'client is waiting' },
    { kind: 'subtask', value: 'Write the SSO fallback', reason: 'risk' },
    { kind: 'comment', value: 'Client wants a demo on Friday.', reason: 'worth keeping' },
  ],
};

let ctx, slack, ai, bob, carol, gina, intId, extId, issue;
const run = () => runDueJobs({ env: ctx.env, req: { url: 'https://tracker.example.com/api/x' } }, { force: 'channel_ai' });
const linkRow = (id) => ctx.db.get('SELECT * FROM channel_links WHERE id = ?', [id]);

async function setup(extra = {}) {
  resetSlackNames();
  resetAiTokens();
  slack = fakeSlack();
  ai = fakeAi();
  ai.state.answer = ANSWER;
  const fetch = (url, init) => (String(url).startsWith('https://slack.com/') ? slack.fetch(url, init) : ai.fetch(url, init));
  ctx = await withAdmin({
    fetch,
    AI_PROVIDER: 'gemini',
    GEMINI_API_KEY: 'gem-secret-key',
    AI_RETRY_MS: 0,
    JOBS_MAX_QUERIES: 500,
    JOBS_MAX_FETCHES: 200,
    PUBLIC_URL: 'https://tracker.example.com',
    now: T0,
    ...extra,
  });
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' }); // project admin (PM)
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
  gina = await addUser(ctx, { email: 'gina@client.example', name: 'Gina', role: 'guest' });
  await bob.client.post('/api/projects', { key: 'web', name: 'Website' });
  await bob.client.put(`/api/projects/WEB/members/${carol.id}`, { role: 'member' });
  await bob.client.put(`/api/projects/WEB/members/${gina.id}`, { role: 'guest-comment' });
  expect((await ctx.admin.put('/api/admin/slack', { token: TOKEN })).status).toBe(200);
  await ctx.admin.patch('/api/admin/settings', { channelAi: true });
  const a = await bob.client.post('/api/projects/WEB/channels', { channelId: 'C0INT1', channelName: 'team-web', kind: 'internal' });
  expect(a.status).toBe(201);
  intId = a.body.channel.id;
  extId = (await bob.client.post('/api/projects/WEB/channels', { channelId: 'C0EXT1', channelName: 'client-web', kind: 'external' })).body
    .channel.id;
  issue = (await bob.client.post('/api/issues', { projectKey: 'WEB', title: 'New login page', watcherIds: [] })).body.issue;
  await carol.client.post(`/api/issues/${issue.key}/watch`);
  await gina.client.post(`/api/issues/${issue.key}/watch`);
}

const PROMPT = 'Dana (client PM) decides scope. Raj is our developer. Messages from Priya are QA findings.';
async function linkAndStart(channel = intId, extra = {}) {
  const l = await carol.client.post(`/api/issues/${issue.key}/channels`, { projectChannelId: channel, prompt: PROMPT, ...extra });
  expect(l.status).toBe(201);
  const on = await bob.client.patch(`/api/channel-links/${l.body.link.id}`, { sessionOn: true });
  expect(on.status).toBe(200);
  return l.body.link.id;
}

function channelMessages() {
  slack.answers['conversations.history'] = (p) => ({
    ok: true,
    messages: [
      { ts: ts(4), user: 'UBOT', bot_id: 'B1', text: 'Bot update: WEB-1 moved' },
      { ts: ts(3), subtype: 'channel_join', user: 'UPRIYA', text: 'joined' },
      { ts: ts(2), user: 'URAJ', text: 'Starting on it today, <@UDANA>' },
      { ts: ts(1), user: 'UDANA', text: 'Approved: login page only &amp; nothing else' },
    ].filter((m) => !p.oldest || m.ts > p.oldest),
  });
}

describe('permissions', () => {
  beforeEach(() => setup());

  it('project admins manage channels; members link; only PMs switch the session; guests see nothing', async () => {
    expect((await carol.client.post('/api/projects/WEB/channels', { channelId: 'C0OTHER', channelName: 'x' })).status).toBe(403);
    expect((await carol.client.get('/api/projects/WEB/channels')).body.channels.map((c) => [c.name, c.kind])).toEqual([
      ['client-web', 'external'],
      ['team-web', 'internal'],
    ]);
    expect((await gina.client.get('/api/projects/WEB/channels')).status).toBe(404);

    const l = await carol.client.post(`/api/issues/${issue.key}/channels`, { projectChannelId: intId, prompt: PROMPT });
    expect(l.status).toBe(201);
    expect(l.body.link).toMatchObject({
      channel: { name: 'team-web', kind: 'internal' },
      prompt: PROMPT,
      sessionOn: false,
      canEditPrompt: true,
    });
    const id = l.body.link.id;
    expect((await carol.client.post(`/api/issues/${issue.key}/channels`, { projectChannelId: intId })).status).toBe(409); // same channel twice
    expect((await gina.client.post(`/api/issues/${issue.key}/channels`, { projectChannelId: intId })).status).toBe(403);
    expect((await gina.client.get(`/api/issues/${issue.key}/channels`)).status).toBe(404);
    expect((await gina.client.patch(`/api/channel-links/${id}`, { sessionOn: true })).status).toBe(404);

    expect((await carol.client.patch(`/api/channel-links/${id}`, { sessionOn: true })).status).toBe(403);
    expect((await carol.client.post(`/api/channel-links/${id}/run`)).status).toBe(403);
    expect((await carol.client.patch(`/api/channel-links/${id}`, { prompt: 'Raj is the developer.' })).body.link.prompt).toBe(
      'Raj is the developer.',
    );
    const on = await bob.client.patch(`/api/channel-links/${id}`, { sessionOn: true });
    expect(on.body.link.sessionOn).toBe(true);
    expect(await ctx.db.get(`SELECT action FROM audit_log WHERE action = 'channel_ai.session_on'`)).toBeTruthy();
    await bob.client.patch(`/api/channel-links/${id}`, { sessionOn: false });
    expect(await ctx.db.get(`SELECT action FROM audit_log WHERE action = 'channel_ai.session_off'`)).toBeTruthy();

    // a link someone else made: members cannot change its prompt or remove it
    const bobs = (await bob.client.post(`/api/issues/${issue.key}/channels`, { projectChannelId: extId, prompt: 'x' })).body.link;
    expect((await carol.client.patch(`/api/channel-links/${bobs.id}`, { prompt: 'y' })).status).toBe(403);
    expect((await carol.client.del(`/api/channel-links/${bobs.id}`)).status).toBe(403);
    expect((await bob.client.del(`/api/channel-links/${bobs.id}`)).status).toBe(200);
  });

  it('a thread link must be a message in that channel', async () => {
    expect(
      (
        await carol.client.post(`/api/issues/${issue.key}/channels`, {
          projectChannelId: intId,
          messageUrl: 'https://acme.slack.com/archives/C0EXT1/p1700000100000100',
        })
      ).status,
    ).toBe(400);
    const l = await carol.client.post(`/api/issues/${issue.key}/channels`, {
      projectChannelId: intId,
      messageUrl: 'https://acme.slack.com/archives/C0INT1/p1700000100000100',
    });
    expect(l.body.link.threadTs).toBe('1700000100.000100');
  });

  it('the workspace switches gate sessions; external channels need their own switch', async () => {
    const l = await carol.client.post(`/api/issues/${issue.key}/channels`, { projectChannelId: extId });
    const r = await bob.client.patch(`/api/channel-links/${l.body.link.id}`, { sessionOn: true });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/external channels are not allowed/);
    await ctx.admin.patch('/api/admin/settings', { channelAiExternal: true });
    expect((await bob.client.patch(`/api/channel-links/${l.body.link.id}`, { sessionOn: true })).status).toBe(200);

    await ctx.admin.patch('/api/admin/settings', { channelAi: false });
    const i = await carol.client.post(`/api/issues/${issue.key}/channels`, { projectChannelId: intId });
    const off = await bob.client.patch(`/api/channel-links/${i.body.link.id}`, { sessionOn: true });
    expect(off.status).toBe(409);
    expect(off.body.error).toMatch(/turned off for the workspace/);
    channelMessages();
    expect((await run()).result.summary).toMatch(/turned off/);
    expect(ai.calls).toHaveLength(0);
  });
});

describe('the channel_ai job', () => {
  beforeEach(() => setup());

  it('reads new messages, skips bots, sends the who-is-who prompt, posts an internal note and stores suggestions', async () => {
    const id = await linkAndStart();
    channelMessages();
    const r = await run();
    expect(r).toMatchObject({ ran: 'channel_ai', status: 'done', result: { links: 1, summaries: 1, suggestions: 6 } });

    // the request: Gemini with the who-is-who text, the internal flag and only people's messages, oldest first
    expect(ai.calls).toHaveLength(1);
    const prompt = ai.calls[0].body.contents[0].parts[0].text;
    expect(prompt).toContain(PROMPT);
    expect(prompt).toContain('an INTERNAL channel');
    expect(prompt).toContain('Allowed statuses: To Do, In Progress');
    expect(prompt).not.toContain('Bot update');
    expect(prompt).not.toContain('joined');
    expect(prompt.indexOf('Dana Client: Approved: login page only & nothing else')).toBeLessThan(
      prompt.indexOf('Raj Dev: Starting on it today, @Dana Client'),
    );
    expect(slack.of('conversations.history')[0].params).toMatchObject({ channel: 'C0INT1' });
    expect(
      slack
        .of('users.info')
        .map((c) => c.params.user)
        .sort(),
    ).toEqual(['UDANA', 'URAJ']);
    expect(slack.of('chat.postMessage')).toHaveLength(0); // never posts back to Slack

    // the internal note by Tracker AI; guests never see it
    const seen = (await bob.client.get(`/api/issues/${issue.key}`)).body.issue.comments;
    const note = seen.find((c) => c.author?.name === 'Tracker AI');
    expect(note.internal).toBe(true);
    expect(note.body).toContain('**From #team-web (internal), 2 messages**');
    expect(note.body).toContain('https://acme.slack.com/archives/C0INT1/p');
    expect(note.body).toContain('Dana approved the new login page.');
    expect(note.body).toContain('- SSO is not ready yet');
    expect((await gina.client.get(`/api/issues/${issue.key}`)).body.issue.comments.some((c) => c.author?.name === 'Tracker AI')).toBe(
      false,
    );
    const notes = await ctx.db.all(`SELECT user_id FROM notifications WHERE type = 'comment' AND message LIKE 'Tracker AI%'`);
    expect(notes.map((n) => n.user_id).sort()).toEqual([bob.id, carol.id].sort()); // watchers, not the guest

    // suggestions (the unknown status left out); the cursor is the newest message, bots included
    const ch = (await carol.client.get(`/api/issues/${issue.key}/channels`)).body;
    expect(ch.suggestions.map((s) => [s.kind, s.value])).toEqual([
      ['status', 'In Progress'],
      ['assignee', 'Carol'],
      ['dueDate', '2026-12-01'],
      ['priority', 'high'],
      ['subtask', 'Write the SSO fallback'],
      ['comment', 'Client wants a demo on Friday.'],
    ]);
    expect(ch.links[0]).toMatchObject({ lastStatus: 'ok', lastResult: { messages: 2, suggestions: 6 } });
    expect((await linkRow(id)).cursor_ts).toBe(ts(4));

    // next run: only messages after the cursor; nothing new means no AI call
    ctx.env.now = T0 + 20 * 60e3;
    const again = await run();
    expect(again.result).toMatchObject({ links: 1, summaries: 0 });
    expect(slack.of('conversations.history')[1].params.oldest).toBe(ts(4));
    expect(ai.calls).toHaveLength(1);
    expect((await linkRow(id)).last_status).toBe('nothing_new');
  });

  it('applies through updateIssue (history), dismisses, and refuses guests and double clicks', async () => {
    await linkAndStart();
    channelMessages();
    await run();
    const list = (await carol.client.get(`/api/issues/${issue.key}/channels`)).body.suggestions;
    const by = (k) => list.find((s) => s.kind === k);

    expect((await gina.client.post(`/api/ai-suggestions/${by('status').id}/apply`)).status).toBe(404);
    const a = await carol.client.post(`/api/ai-suggestions/${by('status').id}/apply`);
    expect(a.status).toBe(200);
    expect((await carol.client.post(`/api/ai-suggestions/${by('status').id}/apply`)).status).toBe(409);
    const detail = (await bob.client.get(`/api/issues/${issue.key}`)).body.issue;
    expect(detail.status.name).toBe('In Progress');
    expect(detail.history.find((h) => h.field === 'status')).toMatchObject({ from: 'To Do', to: 'In Progress', actor: { name: 'Carol' } });
    expect(await ctx.db.get(`SELECT details FROM audit_log WHERE action = 'ai_suggestion.applied'`)).toBeTruthy();

    await carol.client.post(`/api/ai-suggestions/${by('assignee').id}/apply`);
    await carol.client.post(`/api/ai-suggestions/${by('dueDate').id}/apply`);
    const sub = await carol.client.post(`/api/ai-suggestions/${by('subtask').id}/apply`);
    expect(sub.body.key).toBe('WEB-2');
    const after = (await bob.client.get(`/api/issues/${issue.key}`)).body.issue;
    expect(after.assignee.name).toBe('Carol');
    expect(after.dueDate).toBe('2026-12-01');
    expect(after.children.map((c) => [c.key, c.type, c.title])).toEqual([['WEB-2', 'subtask', 'Write the SSO fallback']]);

    expect((await carol.client.post(`/api/ai-suggestions/${by('priority').id}/dismiss`)).status).toBe(200);
    expect((await ctx.db.get('SELECT status FROM ai_suggestions WHERE id = ?', [by('priority').id])).status).toBe('dismissed');
    expect((await bob.client.get(`/api/issues/${issue.key}`)).body.issue.priority).toBe('medium');
    expect((await carol.client.get(`/api/issues/${issue.key}/channels`)).body.suggestions.map((s) => s.kind)).toEqual(['comment']);
  });

  it('applies automatically only the low-risk kinds', async () => {
    const id = await linkAndStart();
    expect((await carol.client.patch(`/api/channel-links/${id}`, { autoApply: true })).status).toBe(403);
    expect((await bob.client.patch(`/api/channel-links/${id}`, { autoApply: true })).body.link.autoApply).toBe(true);
    channelMessages();
    await run();
    const rows = await ctx.db.all('SELECT kind, status FROM ai_suggestions ORDER BY kind');
    expect(Object.fromEntries(rows.map((r) => [r.kind, r.status]))).toEqual({
      assignee: 'pending',
      comment: 'applied',
      dueDate: 'pending',
      priority: 'pending',
      status: 'pending',
      subtask: 'applied',
    });
    const d = (await bob.client.get(`/api/issues/${issue.key}`)).body.issue;
    expect(d.status.name).toBe('To Do');
    expect(d.children).toHaveLength(1);
    expect(d.comments.filter((c) => c.author?.name === 'Tracker AI' && c.internal)).toHaveLength(2);
    expect(await ctx.db.get(`SELECT id FROM audit_log WHERE action = 'ai_suggestion.auto_applied'`)).toBeTruthy();
  });

  it('logs a provider error without message text and keeps the cursor', async () => {
    const id = await linkAndStart();
    channelMessages();
    ai.state.status = 500;
    const r = await run();
    expect(r.result).toMatchObject({ links: 1, errors: 1 });
    expect(ai.calls).toHaveLength(2); // one retry
    const l = await linkRow(id);
    expect(l).toMatchObject({ last_status: 'error', cursor_ts: null });
    expect(l.last_error).toMatch(/AI service returned an error/);
    const errs = await ctx.db.all('SELECT * FROM ai_errors');
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ provider: 'gemini', error: 'http_500 INTERNAL' });
    expect(JSON.stringify(errs)).not.toMatch(/Approved|secret details/);
    const admin = (await ctx.admin.get('/api/admin/ai')).body;
    expect(admin).toMatchObject({ configured: true, provider: 'gemini', model: 'gemini-flash-latest' });
    expect(JSON.stringify(admin)).not.toContain('gem-secret-key');
  });

  it('says to invite the bot when it is not in the channel', async () => {
    const id = await linkAndStart();
    slack.answers['conversations.history'] = { ok: false, error: 'not_in_channel' };
    await run();
    expect((await linkRow(id)).last_error).toBe('Invite the bot to #team-web: in Slack, open the channel and type /invite @tracker.');
    expect(ai.calls).toHaveLength(0);
  });

  it('skips archived projects, the Trash and a turned-off Slack integration', async () => {
    await linkAndStart();
    channelMessages();
    await bob.client.patch('/api/projects/WEB', { archived: true });
    expect((await run()).result.links).toBe(0);
    await bob.client.patch('/api/projects/WEB', { archived: false });
    await bob.client.del(`/api/issues/${issue.key}`);
    expect((await run()).result.links).toBe(0);
    expect(slack.of('conversations.history')).toHaveLength(0);
    await ctx.admin.patch('/api/admin/slack', { enabled: false });
    expect((await run()).result.summary).toMatch(/Slack is not connected or is turned off/);
  });

  it('reads a thread with conversations.replies; Run now works for project admins', async () => {
    const id = await linkAndStart(intId, { messageUrl: 'https://acme.slack.com/archives/C0INT1/p1700000100000100' });
    slack.answers['conversations.replies'] = {
      ok: true,
      messages: [
        { ts: '1700000100.000100', user: 'URAJ', text: 'Thread start' },
        { ts: '1700000200.000100', user: 'UDANA', text: 'Looks good' },
      ],
    };
    const r = await bob.client.post(`/api/channel-links/${id}/run`);
    expect(r.status).toBe(200);
    expect(r.body.result).toMatchObject({ status: 'ok', messages: 2 });
    expect(slack.of('conversations.replies')[0].params).toMatchObject({ channel: 'C0INT1', ts: '1700000100.000100' });
    expect(r.body.link.lastStatus).toBe('ok');
    expect(
      (await bob.client.get(`/api/issues/${issue.key}`)).body.issue.comments.find((c) => c.author?.name === 'Tracker AI').body,
    ).toContain('?thread_ts=1700000100.000100');
  });

  it('MCP get_issue lists the links (no message text) and the pending suggestion count', async () => {
    await linkAndStart();
    channelMessages();
    await run();
    const token = (await bob.client.post('/api/me/tokens', { name: 'Claude' })).body.token;
    const res = await ctx.app.request(
      'http://t.example/mcp',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_issue', arguments: { key: issue.key } } }),
      },
      ctx.env,
    );
    const data = JSON.parse((await res.json()).result.content[0].text);
    expect(data.channelLinks).toEqual([
      { channel: '#team-web', kind: 'internal', thread: false, aiSession: 'on', lastRun: new Date(T0).toISOString() },
    ]);
    expect(data.pendingAiSuggestions).toBe(6);
    expect(JSON.stringify(data.channelLinks)).not.toContain('Approved');
  });

  it('runs on its own every 30 minutes once the switch is on', async () => {
    await linkAndStart();
    channelMessages();
    const auto = () => runDueJobs({ env: ctx.env, req: { url: 'https://tracker.example.com/api/x' } });
    // other jobs are due at 08:00 local; run them first
    for (let i = 0; i < 10; i++) if ((await auto()).ran === null) break;
    expect(ai.calls).toHaveLength(1);
    expect((await auto()).ran).toBe(null); // not again within 30 minutes
    ctx.env.now = T0 + 31 * 60e3;
    expect((await auto()).ran).toBe('channel_ai');
  });
});

describe('AI not configured', () => {
  it('shows it and does nothing', async () => {
    await setup({ AI_PROVIDER: undefined, GEMINI_API_KEY: undefined });
    const l = await carol.client.post(`/api/issues/${issue.key}/channels`, { projectChannelId: intId, prompt: PROMPT });
    const on = await bob.client.patch(`/api/channel-links/${l.body.link.id}`, { sessionOn: true });
    expect(on.status).toBe(409);
    expect(on.body.error).toBe('AI is not configured on the server.');
    expect((await carol.client.get(`/api/issues/${issue.key}/channels`)).body.state.aiConfigured).toBe(false);
    await ctx.db.run('UPDATE channel_links SET session_on = 1');
    channelMessages();
    expect((await run()).result.summary).toMatch(/AI is not configured/);
    expect(slack.calls.filter((c) => c.method !== 'auth.test')).toHaveLength(0);
    expect(ai.calls).toHaveLength(0);
    expect((await ctx.admin.get('/api/admin/ai')).body).toMatchObject({
      configured: false,
      missing: expect.stringContaining('AI_PROVIDER'),
    });
  });
});

describe('the Tracker AI user', () => {
  beforeEach(() => setup());

  it('is hidden from pickers, cannot be assigned and cannot sign in', async () => {
    await linkAndStart();
    channelMessages();
    await run();
    const ai = await ctx.db.get('SELECT * FROM users WHERE email = ?', [AI_EMAIL]);
    expect(ai).toMatchObject({ name: 'Tracker AI', status: 'active', password_hash: null, google_sub: null, is_system: 1 });
    expect((await bob.client.get('/api/users')).body.users.some((u) => u.id === ai.id)).toBe(false);
    expect((await ctx.admin.get('/api/admin/users')).body.users.some((u) => u.id === ai.id)).toBe(false);
    expect((await bob.client.patch(`/api/issues/${issue.key}`, { assigneeId: ai.id })).status).toBe(400);
    expect((await ctx.admin.post(`/api/admin/users/${ai.id}/password`, { password: PASSWORD })).status).toBe(404);
    expect((await ctx.admin.patch(`/api/admin/users/${ai.id}`, { role: 'admin' })).status).toBe(404);
    expect((await (await import('./helpers.js')).client(ctx).post('/api/auth/login', { email: AI_EMAIL, password: PASSWORD })).status).toBe(
      401,
    );
  });

  it('backups hold channels, links and suggestions but no secrets or AI error log', async () => {
    await linkAndStart();
    channelMessages();
    ai.state.statuses = [500, 500];
    await run(); // an error row
    ctx.env.now = T0 + 20 * 60e3;
    slack.answers['conversations.history'] = { ok: true, messages: [{ ts: ts(30), user: 'UDANA', text: 'One more thing' }] };
    await run();
    const r = await ctx.admin.get('/api/admin/backup');
    expect(r.status).toBe(200);
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    const b = JSON.parse(text);
    expect(b.schema).toBe(BACKUP_SCHEMA);
    expect(b.tables.project_channels).toHaveLength(2);
    expect(b.tables.channel_links[0]).toMatchObject({ prompt: PROMPT, session_on: 1 });
    expect(b.tables.ai_suggestions.length).toBeGreaterThan(0);
    expect(b.tables.ai_errors).toBeUndefined();
    expect(b.tables.users.find((u) => u.email === AI_EMAIL)).toMatchObject({ is_system: 1 });
    expect(text).not.toContain('gem-secret-key');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('One more thing'); // Slack messages are never stored
  });
});

describe('providers', () => {
  const answer = { summary: 'ok', decisions: [], risks: [], suggestions: [] };
  const opts = { system: 'sys', prompt: 'hello', json: AI_SCHEMA };
  beforeEach(() => resetAiTokens());

  it('gemini: API key header, JSON mode with a schema; retries once on 429', async () => {
    const f = fakeAi();
    f.state.answer = answer;
    f.state.statuses = [429];
    const r = await aiComplete({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'k1', AI_RETRY_MS: 0, fetch: f.fetch }, opts);
    expect(r.data).toEqual(answer);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent');
    expect(f.calls[1].headers['x-goog-api-key']).toBe('k1');
    expect(f.calls[1].body).toMatchObject({
      systemInstruction: { parts: [{ text: 'sys' }] },
      generationConfig: { responseMimeType: 'application/json', responseSchema: { type: 'OBJECT' } },
    });
    expect(f.calls[1].body.generationConfig.responseSchema.properties.suggestions.items.properties.kind.enum).toContain('subtask');
  });

  it('anthropic: official SDK, Claude Opus 5.5, refusal fallbacks and structured output', async () => {
    const f = fakeAi();
    f.state.answer = answer;
    const r = await aiComplete({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test', fetch: f.fetch }, opts);
    expect(r).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5', data: answer });
    const c = f.calls[0];
    expect(c.url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/messages/);
    expect(c.headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
    expect(`${c.headers['x-api-key'] || ''} ${c.headers.authorization || ''}`).toContain('sk-ant-test'); // the SDK chooses the header
    expect(c.headers['anthropic-version']).toBeTruthy();
    expect(c.body).toMatchObject({
      model: 'claude-opus-5-5',
      system: 'sys',
      fallbacks: 'default',
      messages: [{ role: 'user' }],
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: { type: 'object', additionalProperties: false } } },
    });
    expect(c.body.messages[0].content).toMatch(/^hello/);
    expect(c.body).not.toHaveProperty('thinking');
  });

  it('anthropic: a refusal and an API error become AiErrors without message text', async () => {
    const f = fakeAi();
    f.state.status = 400;
    await expect(
      aiComplete({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k', fetch: f.fetch, AI_MODEL: 'claude-haiku-5-5' }, opts),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^http_400/) });
    expect(f.calls[0].body).not.toHaveProperty('fallbacks'); // only models that support it
  });

  it('vertex: signs a service account JWT, exchanges it once and calls the regional or global endpoint', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const cred = JSON.stringify({
      type: 'service_account',
      client_email: 'tracker@p1.iam.gserviceaccount.com',
      private_key: privateKey,
      private_key_id: 'kid1',
      token_uri: 'https://oauth2.googleapis.com/token',
    });
    const f = fakeAi();
    f.state.answer = answer;
    const env = { AI_PROVIDER: 'vertex', VERTEX_AI_PROJECT_ID: 'p1', VERTEX_AI_CREDENTIALS_JSON: cred, fetch: f.fetch };
    await aiComplete(env, opts);
    await aiComplete(env, opts);
    const tok = f.calls.filter((c) => c.url === 'https://oauth2.googleapis.com/token');
    expect(tok).toHaveLength(1); // cached
    const form = new URLSearchParams(tok[0].body);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [h, p, sig] = form.get('assertion').split('.');
    const verify = createVerify('RSA-SHA256');
    verify.update(`${h}.${p}`);
    expect(verify.verify(publicKey, Buffer.from(sig, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(h, 'base64url'))).toMatchObject({ alg: 'RS256', kid: 'kid1' });
    expect(JSON.parse(Buffer.from(p, 'base64url'))).toMatchObject({
      iss: 'tracker@p1.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: 'https://oauth2.googleapis.com/token',
    });
    const gen = f.calls.filter((c) => c.url !== 'https://oauth2.googleapis.com/token');
    expect(gen[0].url).toBe(
      'https://aiplatform.googleapis.com/v1/projects/p1/locations/global/publishers/google/models/gemini-flash-latest:generateContent',
    );
    expect(gen[0].headers.authorization).toBe('Bearer ya29.test-token');
    expect(gen[0].body.generationConfig.responseMimeType).toBe('application/json');

    resetAiTokens();
    await aiComplete({ ...env, VERTEX_AI_LOCATION: 'us-central1', AI_MODEL: 'gemini-2.5-pro' }, opts);
    expect(f.calls.at(-1).url).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1/projects/p1/locations/us-central1/publishers/google/models/gemini-2.5-pro:generateContent',
    );
  });

  it('refuses without a configuration and reports unreadable answers', async () => {
    await expect(aiComplete({}, opts)).rejects.toBeInstanceOf(AiError);
    const f = fakeAi();
    f.state.answer = 'not json at all';
    await expect(aiComplete({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'k', fetch: f.fetch }, opts)).rejects.toMatchObject({
      code: 'bad_json',
    });
  });
});
