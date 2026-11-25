// Slack integration: bot token storage, Slack Web API calls, channel posts and personal DMs.
// Delivery never blocks or fails the user's request: slackNotify() schedules the work in the background
// (Workers: executionCtx.waitUntil; Node and tests: a caught promise, also pushed to c.env.slackQueue if present).
import { uuid, now } from './crypto.js';
import { defer as deferWork, publicOrigin } from './http.js';
import { parseList } from './json.js';

export const SLACK_SCOPES = [
  { scope: 'chat:write', why: 'post updates and direct messages' },
  { scope: 'chat:write.public', why: 'post in public channels without being invited' },
  { scope: 'channels:read', why: 'list public channels in project settings' },
  { scope: 'groups:read', why: 'list private channels the app was invited to' },
  { scope: 'users:read', why: 'show Slack names when importing a message' },
  { scope: 'users:read.email', why: 'find each person on Slack by email' },
  { scope: 'im:write', why: 'open direct messages for assignments and mentions' },
  { scope: 'channels:history', why: 'read a public channel message to create an issue from it' },
  { scope: 'groups:history', why: 'read a private channel message (the app must be in the channel)' },
  { scope: 'commands', why: 'the /tracker command and the Create issue in Tracker message shortcut' },
];

export const SLACK_EVENTS = ['issue_created', 'status_changed', 'assignee_changed', 'comment_added', 'sprint_started', 'sprint_completed'];
export const DEFAULT_EVENTS = [
  'issue_created',
  'status_changed',
  'assignee_changed',
  'comment_added',
  'sprint_started',
  'sprint_completed',
];

const KEY = 'slack';
const ERROR_ROWS = 50;
const LOOKUP_RETRY_MS = 24 * 3600e3; // look a person up again a day after "not found"

export class SlackError extends Error {
  constructor(method, code) {
    super(code);
    this.method = method;
    this.code = code;
  }
}

// ---- configuration ----

export async function slackConfig(c) {
  const row = await c.env.db.get('SELECT config FROM integrations WHERE key = ?', [KEY]);
  let cfg = {};
  try {
    cfg = row ? JSON.parse(row.config) : {};
  } catch {
    cfg = {};
  }
  const envToken = c.env.SLACK_BOT_TOKEN || '';
  const token = envToken || cfg.token || '';
  // Signing secret for /slack/commands and /slack/interactivity: SLACK_SIGNING_SECRET wins over the saved one.
  const envSecret = c.env.SLACK_SIGNING_SECRET || '';
  return {
    ...cfg,
    token,
    source: envToken ? 'env' : cfg.token ? 'db' : null,
    savedSigningSecret: cfg.signingSecret || '',
    signingSecret: envSecret || cfg.signingSecret || '',
    signingSecretSource: envSecret ? 'env' : cfg.signingSecret ? 'db' : null,
    enabled: cfg.enabled !== false,
    active: Boolean(token) && cfg.enabled !== false,
  };
}

export async function saveSlackConfig(db, cfg) {
  // signingSecret: only a saved one (never one from SLACK_SIGNING_SECRET); pass savedSigningSecret through to keep it.
  const { token, team, teamId, teamUrl, botName, botUserId, enabled, connectedBy, connectedAt } = cfg;
  const signingSecret = cfg.signingSecret === undefined ? cfg.savedSigningSecret || undefined : cfg.signingSecret || undefined;
  await db.batch([
    { sql: 'DELETE FROM integrations WHERE key = ?', params: [KEY] },
    {
      sql: 'INSERT INTO integrations (key, config, updated_at) VALUES (?, ?, ?)',
      params: [
        KEY,
        JSON.stringify({ token, team, teamId, teamUrl, botName, botUserId, enabled, connectedBy, connectedAt, signingSecret }),
        now(),
      ],
    },
  ]);
}

export const last4 = (token) => (token ? token.slice(-4) : null);

// ---- Web API ----

const WRITE_METHODS = ['chat.postMessage', 'conversations.open', 'chat.postEphemeral', 'views.open'];

/** Call a Slack Web API method. Read methods use GET with a query string, writes POST JSON. Throws SlackError when ok is false. */
export async function slackApi(c, method, params = {}, token) {
  const fetchFn = c.env.fetch || fetch;
  const write = WRITE_METHODS.includes(method);
  let url = `https://slack.com/api/${method}`;
  const init = { method: write ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}` } };
  if (write) {
    init.headers['content-type'] = 'application/json; charset=utf-8';
    init.body = JSON.stringify(params);
  } else {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
    const s = q.toString();
    if (s) url += `?${s}`;
  }
  let res;
  try {
    res = await fetchFn(url, init);
  } catch (e) {
    throw new SlackError(method, 'network_error');
  }
  if (res.status === 429) throw new SlackError(method, 'ratelimited');
  let data;
  try {
    data = await res.json();
  } catch {
    throw new SlackError(method, `http_${res.status}`);
  }
  if (!data || !data.ok) {
    const err = new SlackError(method, data?.error || `http_${res.status}`);
    err.needed = data?.needed;
    throw err;
  }
  return data;
}

export async function logSlackError(db, method, error, context) {
  try {
    await db.batch([
      {
        sql: 'INSERT INTO slack_errors (id, method, error, context, created_at) VALUES (?, ?, ?, ?, ?)',
        params: [uuid(), method, String(error).slice(0, 200), context ? String(context).slice(0, 300) : null, now()],
      },
      {
        sql: `DELETE FROM slack_errors WHERE id NOT IN (SELECT id FROM slack_errors ORDER BY created_at DESC LIMIT ${ERROR_ROWS})`,
        params: [],
      },
    ]);
  } catch (e) {
    console.error('slack: could not log error', e);
  }
}

/** Plain words for Slack error codes shown in the UI. */
export function explainSlackError(code, extra = {}) {
  const invite = extra.botName ? `type /invite @${extra.botName}` : 'invite the Slack app (/invite @ followed by the app name)';
  switch (code) {
    case 'not_in_channel':
      return `The Slack app is not in that channel. In Slack, open the channel and ${invite}, then try again.`;
    case 'channel_not_found':
      return `Slack could not find that channel. If it is a private channel, open it in Slack and ${invite} first.`;
    case 'is_archived':
      return 'That Slack channel is archived.';
    case 'missing_scope':
      return `The Slack app is missing a permission${extra.needed ? ` (${extra.needed})` : ''}. An admin can add it at api.slack.com/apps under OAuth & Permissions, then reinstall the app.`;
    case 'invalid_auth':
    case 'not_authed':
    case 'token_revoked':
    case 'account_inactive':
    case 'token_expired':
      return 'The Slack token does not work. An admin needs to check it under Admin > Slack.';
    case 'ratelimited':
      return 'Slack is limiting requests right now. Try again in a minute.';
    case 'network_error':
      return 'Could not reach Slack. Try again in a minute.';
    case 'users_not_found':
      return 'Your email address was not found in the Slack workspace.';
    default:
      return `Slack returned an error: ${code}`;
  }
}

// ---- text helpers ----

const MENTION_RE = /@\[([^\]]{1,100})\]\(user:([0-9a-f-]{36})\)/g;
const mentionIds = (text) => [...new Set([...String(text || '').matchAll(MENTION_RE)].map((m) => m[2]))];

/** Escape for Slack mrkdwn and render `@[Name](user:id)` mentions as @Name. */
export function slackText(text) {
  return String(text || '')
    .replace(MENTION_RE, (_, name) => `@${name}`)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const quote = (s) =>
  s
    .split('\n')
    .map((l) => `>${l}`)
    .join('\n');

// ---- delivery ----

/** Run work in the background without holding up the response (also used by lib/webhooks.js and routes/slackCommands.js). */
export function defer(c, promise) {
  deferWork(c, promise, { label: 'slack delivery failed', queue: c.env.slackQueue });
}

/**
 * Tell Slack about something that happened. Call after the database batch has committed.
 * event.type: issue_created | issue_updated | comment_added | sprint_started | sprint_completed
 * Issue events: issueId, plus
 *   issue_updated: status {from, to} (names), assignee {from, to} (user ids), description {before, after}
 *   comment_added: comment (text)
 *   assigned / mentioned: user ids to DM (the actor is skipped)
 * Sprint events: projectId, sprint {name, goal, startDate, endDate}, movedIssues
 */
export function slackNotify(c, event) {
  try {
    const actor = c.get('user');
    defer(c, deliver(c, { ...event, actor: { id: actor.id, name: actor.name }, origin: publicOrigin(c) }));
  } catch (e) {
    console.error('slack: could not schedule', e);
  }
}

async function deliver(c, ev) {
  const db = c.env.db;
  const cfg = await slackConfig(c);
  if (!cfg.active) return;
  const call = async (method, params, context) => {
    try {
      return await slackApi(c, method, params, cfg.token);
    } catch (e) {
      if (!(e instanceof SlackError)) throw e;
      if (e.code !== 'users_not_found') await logSlackError(db, method, e.code, context);
      return null;
    }
  };

  let issue = null;
  if (ev.issueId) {
    issue = await db.get(
      `SELECT i.id, i.key, i.title, i.type, i.project_id, p.name AS project_name, s.name AS status_name, a.name AS assignee_name
         FROM issues i JOIN projects p ON p.id = i.project_id JOIN statuses s ON s.id = i.status_id LEFT JOIN users a ON a.id = i.assignee_id
        WHERE i.id = ? AND i.deleted_at IS NULL`,
      [ev.issueId],
    );
    if (!issue) return;
  }
  const projectId = issue ? issue.project_id : ev.projectId;
  const link = issue ? `<${ev.origin}/browse/${issue.key}|${issue.key}>` : '';
  const head = issue ? `*${link}* ${slackText(issue.title)}` : '';

  // channel post
  const ps = projectId
    ? await db.get('SELECT channel_id, channel_name, events FROM project_slack WHERE project_id = ?', [projectId])
    : null;
  if (ps) {
    const events = parseList(ps.events);
    const on = (name) => events.includes(name);
    const who = slackText(ev.actor.name);
    const lines = [];
    let extra = null;
    if (ev.type === 'issue_created' && on('issue_created')) {
      lines.push(
        `${who} created ${issue.type === 'epic' ? 'an' : 'a'} ${issue.type}. Status: ${slackText(issue.status_name)}. Assignee: ${slackText(issue.assignee_name || 'Unassigned')}`,
      );
    }
    if (ev.type === 'issue_updated') {
      if (ev.status && on('status_changed'))
        lines.push(`${who} moved it from ${slackText(ev.status.from)} to *${slackText(ev.status.to)}*`);
      if (ev.assignee && on('assignee_changed')) {
        lines.push(ev.assignee.to ? `${who} assigned it to *${slackText(issue.assignee_name || 'someone')}*` : `${who} unassigned it`);
      }
    }
    if (ev.type === 'comment_added' && on('comment_added')) {
      lines.push(ev.reply ? `${who} replied to a comment:` : `${who} commented:`);
      extra = quote(cut(slackText(ev.comment), 2500));
    }
    let sprintText = null;
    if (ev.type === 'sprint_started' && on('sprint_started')) {
      const proj = await db.get('SELECT name FROM projects WHERE id = ?', [projectId]);
      sprintText = `${who} started *${slackText(ev.sprint.name)}* in ${slackText(proj?.name || '')}${ev.sprint.startDate ? ` (${ev.sprint.startDate} to ${ev.sprint.endDate})` : ''}`;
      if (ev.sprint.goal) sprintText += `\nGoal: ${slackText(ev.sprint.goal)}`;
    }
    if (ev.type === 'sprint_completed' && on('sprint_completed')) {
      const proj = await db.get('SELECT name FROM projects WHERE id = ?', [projectId]);
      const next = ev.movedToId ? await db.get('SELECT name FROM sprints WHERE id = ?', [ev.movedToId]) : null;
      sprintText = `${who} completed *${slackText(ev.sprint.name)}* in ${slackText(proj?.name || '')}`;
      if (ev.movedIssues)
        sprintText += `. ${ev.movedIssues} unfinished issue${ev.movedIssues === 1 ? '' : 's'} moved to ${slackText(next?.name || 'the backlog')}.`;
    }
    let text = null;
    if (lines.length) text = [head, ...lines, ...(extra ? [extra] : [])].join('\n');
    else if (sprintText) text = sprintText;
    if (text) {
      const fallback = issue ? `${issue.key} ${issue.title}: ${lines.join(' ')}` : sprintText.replace(/\*/g, '');
      await call(
        'chat.postMessage',
        {
          channel: ps.channel_id,
          text: cut(fallback, 300),
          unfurl_links: false,
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text: cut(text, 2950) } }],
        },
        `${ev.type} ${issue ? issue.key : ''} to #${ps.channel_name || ps.channel_id}`.trim(),
      );
    }
  }

  // personal DMs (assigned / mentioned), never to the person who did it
  if (!issue) return;
  const dms = new Map();
  for (const id of ev.assigned || []) if (id && id !== ev.actor.id) dms.set(id, 'assigned');
  let mentioned = ev.mentioned || [];
  if (ev.description) {
    const before = new Set(mentionIds(ev.description.before));
    mentioned = mentionIds(ev.description.after).filter((id) => !before.has(id));
  }
  for (const id of mentioned) if (id && !dms.has(id)) dms.set(id, 'mentioned'); // a self-mention DMs you too
  for (const [userId, kind] of dms) {
    const slackId = await slackUserFor(c, userId, call);
    if (!slackId) continue;
    const who = slackText(ev.actor.name);
    let text =
      kind === 'assigned'
        ? `${who} assigned ${link} to you: ${slackText(issue.title)}`
        : `${who} mentioned you in ${link}: ${slackText(issue.title)}`;
    if (kind === 'mentioned' && ev.type === 'comment_added' && ev.comment) text += `\n${quote(cut(slackText(ev.comment), 1500))}`;
    const open = await call('conversations.open', { users: slackId }, `DM for ${issue.key}`);
    const channel = open?.channel?.id;
    if (!channel) continue;
    await call(
      'chat.postMessage',
      {
        channel,
        text: cut(text.replace(/<[^|>]+\|([^>]+)>/g, '$1'), 300),
        unfurl_links: false,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: cut(text, 2950) } }],
      },
      `DM for ${issue.key}`,
    );
  }
}

/** Slack user id for a tracker user (by email, cached), or null when not found or they turned DMs off. */
export async function slackUserFor(c, userId, call) {
  const db = c.env.db;
  const u = await db.get(
    `SELECT u.email, u.status, s.slack_user_id, s.looked_up_at, s.dm_enabled FROM users u LEFT JOIN slack_users s ON s.user_id = u.id WHERE u.id = ?`,
    [userId],
  );
  if (!u || u.status === 'deactivated') return null;
  if (u.dm_enabled !== null && u.dm_enabled !== undefined && !Number(u.dm_enabled)) return null;
  if (u.slack_user_id) return u.slack_user_id;
  if (u.looked_up_at && Date.now() - new Date(u.looked_up_at).getTime() < LOOKUP_RETRY_MS) return null;
  const r = await call('users.lookupByEmail', { email: u.email }, 'lookup by email');
  const sid = r?.user?.id || null;
  await db.run(
    `INSERT INTO slack_users (user_id, slack_user_id, looked_up_at, dm_enabled) VALUES (?, ?, ?, 1)
     ON CONFLICT (user_id) DO UPDATE SET slack_user_id = excluded.slack_user_id, looked_up_at = excluded.looked_up_at`,
    [userId, sid, now()],
  );
  return sid;
}

/** Slack user id for the signed-in person (by email, cached); throws SlackError users_not_found. */
export async function ownSlackUser(c, token) {
  const db = c.env.db;
  const user = c.get('user');
  const row = await db.get('SELECT slack_user_id FROM slack_users WHERE user_id = ?', [user.id]);
  if (row?.slack_user_id) return row.slack_user_id;
  const r = await slackApi(c, 'users.lookupByEmail', { email: user.email }, token);
  await db.run(
    `INSERT INTO slack_users (user_id, slack_user_id, looked_up_at, dm_enabled) VALUES (?, ?, ?, 1)
     ON CONFLICT (user_id) DO UPDATE SET slack_user_id = excluded.slack_user_id, looked_up_at = excluded.looked_up_at`,
    [user.id, r.user.id, now()],
  );
  return r.user.id;
}

export { mentionIds };
