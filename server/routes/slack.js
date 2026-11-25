import { body, fail, str } from '../lib/http.js';
import { now } from '../lib/crypto.js';
import { requireAdmin, requireWriter, requireNotGuest } from '../lib/session.js';
import { audit } from '../lib/audit.js';
import { projectAccess } from '../lib/access.js';
import { publicOrigin } from '../lib/http.js';
import { parseJson } from '../lib/json.js';
import {
  SLACK_SCOPES,
  SLACK_EVENTS,
  DEFAULT_EVENTS,
  SlackError,
  slackConfig,
  saveSlackConfig,
  slackApi,
  logSlackError,
  explainSlackError,
  last4,
  ownSlackUser,
} from '../lib/slack.js';

const CHANNEL_CACHE_MS = 60e3;
const channelCache = new Map(); // token -> { at, channels }

/** Turn a SlackError into a plain-words API error. */
function slackFail(e, cfg, status = 400) {
  if (!(e instanceof SlackError)) throw e;
  fail(status, explainSlackError(e.code, { botName: cfg?.botName, needed: e.needed }), { slackError: e.code });
}

async function activeConfig(c) {
  const cfg = await slackConfig(c);
  if (!cfg.token) fail(409, 'Slack is not connected. An admin can connect it under Admin > Slack.');
  if (!cfg.enabled) fail(409, 'The Slack integration is turned off. An admin can turn it on under Admin > Slack.');
  return cfg;
}

async function adminView(c) {
  const cfg = await slackConfig(c);
  const errors = await c.env.db.all('SELECT method, error, context, created_at FROM slack_errors ORDER BY created_at DESC LIMIT 50');
  return {
    connected: Boolean(cfg.token),
    source: cfg.source,
    managedOnServer: cfg.source === 'env',
    tokenLast4: last4(cfg.token),
    enabled: cfg.enabled,
    team: cfg.team || null,
    teamUrl: cfg.teamUrl || null,
    botName: cfg.botName || null,
    connectedAt: cfg.connectedAt || null,
    scopes: SLACK_SCOPES,
    // slash command and shortcut (routes/slackCommands.js); the secret itself is never sent
    signingSecretSet: Boolean(cfg.signingSecret),
    signingSecretOnServer: cfg.signingSecretSource === 'env',
    commandsUrl: `${publicOrigin(c)}/slack/commands`,
    interactivityUrl: `${publicOrigin(c)}/slack/interactivity`,
    errors: errors.map((r) => ({
      method: r.method,
      error: r.error,
      context: r.context,
      at: r.created_at,
      explanation: explainSlackError(r.error, { botName: cfg.botName }),
    })),
  };
}

async function authTest(c, token) {
  const r = await slackApi(c, 'auth.test', {}, token);
  return { team: r.team || null, teamId: r.team_id || null, teamUrl: r.url || null, botName: r.user || null, botUserId: r.user_id || null };
}

const TOKEN_RE = /^xoxb-[A-Za-z0-9-]{10,250}$/;

// ---- message links ----

/** Parse https://<workspace>.slack.com/archives/<channel>/p<digits>[?thread_ts=...]. */
export function parseSlackLink(url) {
  let u;
  try {
    u = new URL(String(url || '').trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !/(^|\.)slack\.com$/.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/archives\/([CGD][A-Z0-9]{2,30})\/p(\d{10})(\d{6})\/?$/);
  if (!m) return null;
  const ts = `${m[2]}.${m[3]}`;
  const tt = u.searchParams.get('thread_ts');
  const threadTs = tt && /^\d{10}\.\d{6}$/.test(tt) ? tt : null;
  return {
    channel: m[1],
    ts,
    threadTs: threadTs && threadTs !== ts ? threadTs : null,
    permalink: `${u.origin}${u.pathname}${threadTs && threadTs !== ts ? `?thread_ts=${threadTs}` : ''}`,
  };
}

/** Slack mrkdwn to plain text: user and channel mentions, links, entities. */
export function plainText(text, names) {
  return String(text || '')
    .replace(/<@([UW][A-Z0-9]+)(\|[^>]*)?>/g, (_, id) => `@${names.get(id) || id}`)
    .replace(/<#[CG][A-Z0-9]+\|([^>]*)>/g, (_, n) => `#${n}`)
    .replace(/<!(here|channel|everyone)>/g, '@$1')
    .replace(/<!subteam\^[A-Z0-9]+\|([^>]*)>/g, '$1')
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/<mailto:[^|>]+\|([^>]+)>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function registerSlack(app) {
  // ---- admin ----
  app.get('/api/admin/slack', async (c) => {
    requireAdmin(c);
    return c.json(await adminView(c));
  });

  // Test a pasted token (or the saved one when none is given). Nothing is stored.
  app.post('/api/admin/slack/test', async (c) => {
    requireAdmin(c);
    const b = await body(c);
    const cfg = await slackConfig(c);
    const token = b.token ? str(b.token, { max: 300, name: 'Token' }) : cfg.token;
    if (!token) fail(400, 'Paste a bot token first');
    if (b.token && !TOKEN_RE.test(token))
      fail(400, 'A bot token starts with xoxb-. Copy the Bot User OAuth Token from OAuth & Permissions.');
    try {
      const info = await authTest(c, token);
      return c.json({ ok: true, team: info.team, teamUrl: info.teamUrl, botName: info.botName });
    } catch (e) {
      slackFail(e, cfg);
    }
  });

  app.put('/api/admin/slack', async (c) => {
    requireAdmin(c);
    const cfg = await slackConfig(c);
    if (cfg.source === 'env') fail(409, 'The Slack token is managed on the server (SLACK_BOT_TOKEN). Change it there.');
    const token = str((await body(c)).token, { required: true, max: 300, name: 'Token' });
    if (!TOKEN_RE.test(token)) fail(400, 'A bot token starts with xoxb-. Copy the Bot User OAuth Token from OAuth & Permissions.');
    let info;
    try {
      info = await authTest(c, token);
    } catch (e) {
      slackFail(e, cfg);
    }
    const user = c.get('user');
    await saveSlackConfig(c.env.db, {
      token,
      ...info,
      enabled: cfg.enabled,
      connectedBy: user.id,
      connectedAt: now(),
      savedSigningSecret: cfg.savedSigningSecret,
    });
    channelCache.clear();
    await c.env.db.batch([
      audit(user.id, 'slack.connected', 'integration', 'slack', { team: info.team, botName: info.botName, tokenLast4: last4(token) }),
    ]);
    return c.json(await adminView(c));
  });

  app.patch('/api/admin/slack', async (c) => {
    requireAdmin(c);
    const b = await body(c);
    if (typeof b.enabled !== 'boolean') fail(400, 'enabled must be true or false');
    const cfg = await slackConfig(c);
    const { token, source, active, signingSecret, ...rest } = cfg; // rest.savedSigningSecret keeps a saved signing secret
    await saveSlackConfig(c.env.db, { ...rest, token: source === 'db' ? token : undefined, enabled: b.enabled });
    await c.env.db.batch([audit(c.get('user').id, b.enabled ? 'slack.enabled' : 'slack.disabled', 'integration', 'slack', null)]);
    return c.json(await adminView(c));
  });

  app.delete('/api/admin/slack', async (c) => {
    requireAdmin(c);
    const cfg = await slackConfig(c);
    if (cfg.source === 'env') fail(409, 'The Slack token is managed on the server (SLACK_BOT_TOKEN). Remove it there.');
    await c.env.db.batch([
      { sql: 'DELETE FROM integrations WHERE key = ?', params: ['slack'] },
      { sql: 'UPDATE slack_users SET slack_user_id = NULL, looked_up_at = NULL', params: [] },
      audit(c.get('user').id, 'slack.removed', 'integration', 'slack', null),
    ]);
    channelCache.clear();
    return c.json(await adminView(c));
  });

  // Signing secret (Basic Information > App Credentials), needed for the /tracker command and the message shortcut.
  app.put('/api/admin/slack/signing-secret', async (c) => {
    requireAdmin(c);
    const cfg = await slackConfig(c);
    if (cfg.signingSecretSource === 'env')
      fail(409, 'The signing secret is managed on the server (SLACK_SIGNING_SECRET). Change it there.');
    const secret = str((await body(c)).secret, { required: true, max: 200, name: 'Signing secret' });
    if (!/^[A-Za-z0-9]{16,128}$/.test(secret))
      fail(400, 'Copy the Signing Secret from Basic Information > App Credentials (letters and digits, not the bot token).');
    const { token, source, active, signingSecret, savedSigningSecret, ...rest } = cfg;
    await saveSlackConfig(c.env.db, { ...rest, token: source === 'db' ? token : undefined, signingSecret: secret });
    await c.env.db.batch([audit(c.get('user').id, 'slack.signing_secret_saved', 'integration', 'slack', null)]);
    return c.json(await adminView(c));
  });

  app.delete('/api/admin/slack/signing-secret', async (c) => {
    requireAdmin(c);
    const cfg = await slackConfig(c);
    if (cfg.signingSecretSource === 'env')
      fail(409, 'The signing secret is managed on the server (SLACK_SIGNING_SECRET). Remove it there.');
    const { token, source, active, signingSecret, savedSigningSecret, ...rest } = cfg;
    await saveSlackConfig(c.env.db, { ...rest, token: source === 'db' ? token : undefined, signingSecret: '' });
    await c.env.db.batch([audit(c.get('user').id, 'slack.signing_secret_removed', 'integration', 'slack', null)]);
    return c.json(await adminView(c));
  });

  app.delete('/api/admin/slack/errors', async (c) => {
    requireAdmin(c);
    await c.env.db.run('DELETE FROM slack_errors');
    return c.json(await adminView(c));
  });

  // ---- everyone ----
  app.get('/api/slack/status', async (c) => {
    const cfg = await slackConfig(c);
    const me = await c.env.db.get('SELECT dm_enabled, slack_user_id FROM slack_users WHERE user_id = ?', [c.get('user').id]);
    return c.json({ connected: cfg.active, team: cfg.active ? cfg.team || null : null, dm: me ? Boolean(Number(me.dm_enabled)) : true });
  });

  app.put('/api/me/slack', async (c) => {
    const b = await body(c);
    if (typeof b.dm !== 'boolean') fail(400, 'dm must be true or false');
    await c.env.db.run(
      `INSERT INTO slack_users (user_id, slack_user_id, looked_up_at, dm_enabled) VALUES (?, NULL, NULL, ?)
       ON CONFLICT (user_id) DO UPDATE SET dm_enabled = excluded.dm_enabled`,
      [c.get('user').id, b.dm ? 1 : 0],
    );
    return c.json({ dm: b.dm });
  });

  // ---- project channel ----
  app.get('/api/projects/:key/slack', async (c) => {
    const a = await projectAccess(c, c.req.param('key'), 'admin');
    const cfg = await slackConfig(c);
    const row = await c.env.db.get('SELECT channel_id, channel_name, events FROM project_slack WHERE project_id = ?', [a.project.id]);
    const events = row ? parseJson(row.events, []) : DEFAULT_EVENTS;
    return c.json({
      connected: cfg.active,
      botName: cfg.botName || null,
      channel: row ? { id: row.channel_id, name: row.channel_name } : null,
      events,
      allEvents: SLACK_EVENTS,
    });
  });

  app.get('/api/projects/:key/slack/channels', async (c) => {
    await projectAccess(c, c.req.param('key'), 'admin');
    const cfg = await activeConfig(c);
    const hit = channelCache.get(cfg.token);
    if (hit && Date.now() - hit.at < CHANNEL_CACHE_MS && c.req.query('refresh') !== '1') return c.json({ channels: hit.channels });
    const channels = [];
    let cursor;
    try {
      for (let page = 0; page < 20; page++) {
        const r = await slackApi(
          c,
          'conversations.list',
          { types: 'public_channel,private_channel', exclude_archived: 'true', limit: 200, cursor },
          cfg.token,
        );
        for (const ch of r.channels || []) {
          if (ch.is_private && !ch.is_member) continue;
          channels.push({ id: ch.id, name: ch.name, isPrivate: Boolean(ch.is_private), isMember: Boolean(ch.is_member) });
        }
        cursor = r.response_metadata?.next_cursor;
        if (!cursor) break;
      }
    } catch (e) {
      if (e instanceof SlackError) await logSlackError(c.env.db, e.method, e.code, 'list channels');
      slackFail(e, cfg);
    }
    channels.sort((x, y) => x.name.localeCompare(y.name));
    channelCache.set(cfg.token, { at: Date.now(), channels });
    return c.json({ channels });
  });

  app.put('/api/projects/:key/slack', async (c) => {
    const a = await projectAccess(c, c.req.param('key'), 'admin');
    const b = await body(c);
    const db = c.env.db;
    const user = c.get('user');
    if (!b.channelId) {
      await db.batch([
        { sql: 'DELETE FROM project_slack WHERE project_id = ?', params: [a.project.id] },
        audit(user.id, 'project.slack_removed', 'project', a.project.id, null),
      ]);
      return c.json({ channel: null, events: DEFAULT_EVENTS });
    }
    if (typeof b.channelId !== 'string' || !/^[CG][A-Z0-9]{2,30}$/.test(b.channelId)) fail(400, 'Choose a channel from the list');
    const name = str(b.channelName, { max: 100, name: 'Channel name' }) || null;
    const events = Array.isArray(b.events) ? [...new Set(b.events.filter((e) => SLACK_EVENTS.includes(e)))] : DEFAULT_EVENTS;
    await activeConfig(c);
    await db.batch([
      { sql: 'DELETE FROM project_slack WHERE project_id = ?', params: [a.project.id] },
      {
        sql: 'INSERT INTO project_slack (project_id, channel_id, channel_name, events, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        params: [a.project.id, b.channelId, name, JSON.stringify(events), user.id, now()],
      },
      audit(user.id, 'project.slack_updated', 'project', a.project.id, { channelId: b.channelId, channelName: name, events }),
    ]);
    return c.json({ channel: { id: b.channelId, name }, events });
  });

  // ---- create an issue from a Slack message ----
  app.post('/api/slack/message', async (c) => {
    requireWriter(c);
    requireNotGuest(c, 'read Slack messages'); // the Slack workspace is internal
    const cfg = await activeConfig(c);
    const link = parseSlackLink((await body(c)).url);
    if (!link) fail(400, 'That is not a Slack message link. In Slack, open the message menu (⋮) and choose Copy link.');
    if (link.channel.startsWith('D')) fail(400, 'Messages from direct messages cannot be imported. Use a message from a channel.');
    const call = (method, params) => slackApi(c, method, params, cfg.token);
    try {
      // Private channels: only people who are in the channel on Slack may import from it.
      const info = await call('conversations.info', { channel: link.channel });
      if (info.channel?.is_private || info.channel?.is_mpim) {
        let mine;
        try {
          mine = await ownSlackUser(c, cfg.token);
        } catch (e) {
          if (e instanceof SlackError && e.code === 'users_not_found')
            fail(
              403,
              'This is a private channel and your email address was not found in the Slack workspace, so it cannot be checked that you are in the channel.',
            );
          throw e;
        }
        let member = false;
        let cursor;
        for (let page = 0; page < 20 && !member; page++) {
          const r = await call('conversations.members', { channel: link.channel, limit: 1000, cursor });
          member = (r.members || []).includes(mine);
          cursor = r.response_metadata?.next_cursor;
          if (!cursor) break;
        }
        if (!member) fail(403, 'This is a private channel you are not in on Slack.');
      }

      let message;
      let thread = [];
      if (link.threadTs) {
        const r = await call('conversations.replies', { channel: link.channel, ts: link.threadTs, limit: 100 });
        const all = r.messages || [];
        message = all.find((m) => m.ts === link.ts);
        thread = all.filter((m) => m.ts !== link.ts && m.ts > link.ts).slice(0, 20);
      } else {
        const r = await call('conversations.history', {
          channel: link.channel,
          latest: link.ts,
          oldest: link.ts,
          inclusive: 'true',
          limit: 1,
        });
        message = (r.messages || []).find((m) => m.ts === link.ts);
        if (message && message.reply_count) {
          const t = await call('conversations.replies', { channel: link.channel, ts: link.ts, limit: 21 });
          thread = (t.messages || []).filter((m) => m.ts !== link.ts).slice(0, 20);
        }
      }
      if (!message) fail(404, 'Slack has no message at that link. It may have been deleted.');

      // names for authors and @mentions
      const names = new Map();
      const ids = new Set();
      for (const m of [message, ...thread]) {
        if (m.user) ids.add(m.user);
        for (const x of String(m.text || '').matchAll(/<@([UW][A-Z0-9]+)/g)) ids.add(x[1]);
      }
      for (const id of [...ids].slice(0, 30)) {
        try {
          const u = await call('users.info', { user: id });
          names.set(id, u.user?.profile?.display_name || u.user?.real_name || u.user?.name || id);
        } catch (e) {
          if (!(e instanceof SlackError)) throw e;
          names.set(id, id);
        }
      }
      const author = (m) => (m.user ? names.get(m.user) || m.user : m.username || m.bot_profile?.name || 'Slack');
      const out = (m) => ({ author: author(m), text: plainText(m.text, names), ts: m.ts });
      return c.json({ ...out(message), permalink: link.permalink, channel: info.channel?.name || null, replies: thread.map(out) });
    } catch (e) {
      if (!(e instanceof SlackError)) throw e;
      await logSlackError(c.env.db, e.method, e.code, 'import message');
      slackFail(e, cfg);
    }
  });
}
