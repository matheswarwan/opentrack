// Slack slash command (/tracker) and message shortcut ("Create issue in Tracker").
//
// Public endpoints, outside /api and without a session: POST /slack/commands and POST /slack/interactivity.
// Every request must carry a valid Slack v0 signature (HMAC-SHA256 of `v0:<timestamp>:<raw body>` with the app's
// signing secret, SLACK_SIGNING_SECRET or the one saved under Admin > Slack) and a timestamp within 5 minutes.
// The Slack user is matched to a tracker user by email (users.info, needs users:read.email; cached in slack_users),
// then everything runs as that person with the normal permission checks (lib/access.js).
import { ApiError } from '../lib/http.js';
import { safeEqual, now } from '../lib/crypto.js';
import { slackConfig, slackApi, SlackError, logSlackError, slackText, defer } from '../lib/slack.js';
import { sign } from '../lib/webhooks.js';
import { visibleProjectsSql, permissions } from '../lib/access.js';
import { createIssue } from '../lib/issues/write.js';
import { loadIssue } from '../lib/issues/guards.js';
import { searchIssues } from '../lib/issues/search.js';
import { TYPES } from '../lib/issues/model.js';
import { plainText } from './slack.js';
import { publicOrigin } from '../lib/http.js';

const MAX_AGE_S = 300;
export const SHORTCUT_CALLBACK = 'create_issue'; // the Callback ID to give the message shortcut in the Slack app
const VIEW_CALLBACK = 'tracker_create_issue';
const CREATE_TYPES = TYPES.filter((t) => t !== 'subtask');

const ephemeral = (c, text) => c.json({ response_type: 'ephemeral', text });

/** Check Slack's signature. Returns null when it is good, else a Response to send. */
export async function verifySlackRequest(c, raw, secret) {
  if (!secret) return c.text('Slack commands are not set up: the signing secret is missing (Admin > Slack).', 503);
  const ts = c.req.header('x-slack-request-timestamp') || '';
  const sig = c.req.header('x-slack-signature') || '';
  if (!/^\d{1,12}$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > MAX_AGE_S) return c.text('Stale or missing timestamp', 401);
  const expected = `v0=${await sign(secret, `v0:${ts}:${raw}`)}`;
  if (!safeEqual(sig, expected)) return c.text('Bad signature', 401);
  return null;
}

const USER_COLS = 'u.id, u.email, u.name, u.title, u.role, u.status, u.avatar_color';

/** The tracker user for a Slack user id, by their Slack email (cached). null when there is no active match. */
async function trackerUser(c, cfg, slackUserId) {
  const db = c.env.db;
  if (!/^[UW][A-Z0-9]{2,30}$/.test(String(slackUserId || ''))) return null;
  const cached = await db.get(`SELECT ${USER_COLS} FROM slack_users s JOIN users u ON u.id = s.user_id WHERE s.slack_user_id = ?`, [
    slackUserId,
  ]);
  if (cached) return cached.status === 'active' ? cached : null;
  let info;
  try {
    info = await slackApi(c, 'users.info', { user: slackUserId }, cfg.token);
  } catch (e) {
    if (!(e instanceof SlackError)) throw e;
    await logSlackError(db, e.method, e.code, 'match a /tracker user');
    return null;
  }
  const email = String(info.user?.profile?.email || '')
    .trim()
    .toLowerCase();
  if (!email || info.user?.deleted || info.user?.is_bot) return null;
  const u = await db.get(`SELECT ${USER_COLS} FROM users u WHERE LOWER(u.email) = ?`, [email]);
  if (!u || u.status !== 'active') return null;
  await db.run(
    `INSERT INTO slack_users (user_id, slack_user_id, looked_up_at, dm_enabled) VALUES (?, ?, ?, 1)
     ON CONFLICT (user_id) DO UPDATE SET slack_user_id = excluded.slack_user_id, looked_up_at = excluded.looked_up_at`,
    [u.id, slackUserId, now()],
  );
  return u;
}

const NO_MATCH =
  'Your Slack email address does not match an active account in the tracker, so nothing was done. Ask an admin to add you with the same email you use in Slack.';

/** Set up the request so the normal permission checks run as `user`. */
function actAs(c, user) {
  c.set('user', user);
  c.set('authVia', 'slack');
}

/** Common checks for both endpoints: signature, Slack connected, the right workspace. Returns { cfg } or { res }. */
async function begin(c, raw, teamId) {
  const cfg = await slackConfig(c);
  const bad = await verifySlackRequest(c, raw, cfg.signingSecret);
  if (bad) return { res: bad };
  if (!cfg.active) return { cfg, off: true };
  if (cfg.teamId && teamId && teamId !== cfg.teamId) return { cfg, otherTeam: true };
  return { cfg };
}

const OFF =
  'The tracker is not connected to Slack right now (no bot token, or the integration is turned off). An admin can fix this under Admin > Slack.';
const OTHER_TEAM = 'This Slack workspace is not the one connected to the tracker.';

function helpText(origin) {
  return [
    '*Tracker commands*',
    '`/tracker create WEB Fix the login page` creates a task in project WEB (start the title with `bug:`, `story:` or `epic:` for another type)',
    '`/tracker WEB-12` shows a short summary of an issue',
    '`/tracker mine` lists your open issues',
    '`/tracker help` shows this help',
    `You can also use the message menu: More actions > Create issue in Tracker. Tracker: ${origin}`,
  ].join('\n');
}

const link = (origin, key) => `<${origin}/browse/${key}|${key}>`;

async function runCommand(c, user, text) {
  const origin = publicOrigin(c);
  const [first = '', ...rest] = text.trim().split(/\s+/);
  const word = first.toLowerCase();
  if (!word || word === 'help') return helpText(origin);

  if (word === 'mine') {
    const r = await searchIssues(
      c.env.db,
      user,
      { assignee: 'me', category: 'todo,in_progress', limit: 10, sort: 'updated' },
      { blocked: false },
    );
    if (!r.issues.length) return 'You have no open issues.';
    const lines = r.issues.map((i) => `${link(origin, i.key)} ${slackText(i.title)} (${slackText(i.status?.name || '')})`);
    const more =
      r.total > r.issues.length
        ? `\n${r.total - r.issues.length} more: <${origin}/issues?assignee=me&category=todo,in_progress|see all>`
        : '';
    return `*Your open issues*\n${lines.join('\n')}${more}`;
  }

  if (word === 'create') {
    const projectKey = (rest[0] || '').toUpperCase();
    let title = rest.slice(1).join(' ').trim();
    if (!projectKey || !title) return 'Write it like this: `/tracker create WEB Fix the login page`';
    let type = 'task';
    const m = title.match(/^(bug|story|task|epic):\s*(.+)$/i);
    if (m) {
      type = m[1].toLowerCase();
      title = m[2].trim();
    }
    try {
      const issue = await createIssue(c, { projectKey, type, title: title.slice(0, 255) });
      return `Created ${link(origin, issue.key)} ${slackText(issue.title)} in ${slackText(issue.projectName || projectKey)}.`;
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      if (e.status === 404) return `Project ${slackText(projectKey)} was not found, or you cannot see it.`;
      return `Could not create the issue: ${slackText(e.message)}`;
    }
  }

  if (/^[A-Z][A-Z0-9]*-\d+$/i.test(first)) {
    try {
      const { row } = await loadIssue(c, first.toUpperCase(), 'view');
      const lines = [
        `*${link(origin, row.key)}* ${slackText(row.title)}`,
        `Type: ${row.type}. Status: ${slackText(row.status_name)}. Priority: ${row.priority}. Assignee: ${slackText(row.assignee_name || 'Unassigned')}.`,
        `Project: ${slackText(row.project_name)}${row.due_date ? `. Due ${row.due_date}` : ''}`,
      ];
      return lines.join('\n');
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      return `${slackText(first.toUpperCase())} was not found, or you cannot see it.`;
    }
  }

  return `Sorry, I did not understand that.\n${helpText(origin)}`;
}

/** Projects this person can create issues in (for the shortcut's project list). */
async function creatableProjects(db, user) {
  const v = visibleProjectsSql(user);
  const rows = await db.all(
    `SELECT p.*, m.role AS member_role FROM projects p LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = ?
      WHERE ${v.sql} AND p.archived = 0 ORDER BY p.name LIMIT 300`,
    [user.id, ...v.params],
  );
  return rows.filter((p) => permissions(user, p, p.member_role).canCreate).slice(0, 100);
}

const opt = (text, value) => ({ text: { type: 'plain_text', text: String(text).slice(0, 75) }, value: String(value) });
const cutText = (s, n) => (s.length > n ? s.slice(0, n) : s);

function createModal(projects, message, meta) {
  const text = plainText(message?.text || '', new Map()).trim();
  const firstLine = (text.split('\n').find((l) => l.trim()) || '').trim();
  return {
    type: 'modal',
    callback_id: VIEW_CALLBACK,
    private_metadata: JSON.stringify(meta),
    title: { type: 'plain_text', text: 'Create issue' },
    submit: { type: 'plain_text', text: 'Create' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'project',
        label: { type: 'plain_text', text: 'Project' },
        element: {
          type: 'static_select',
          action_id: 'value',
          options: projects.map((p) => opt(`${p.name} (${p.key})`, p.key)),
          ...(projects.length === 1 ? { initial_option: opt(`${projects[0].name} (${projects[0].key})`, projects[0].key) } : {}),
        },
      },
      {
        type: 'input',
        block_id: 'type',
        label: { type: 'plain_text', text: 'Type' },
        element: {
          type: 'static_select',
          action_id: 'value',
          options: CREATE_TYPES.map((t) => opt(t[0].toUpperCase() + t.slice(1), t)),
          initial_option: opt('Task', 'task'),
        },
      },
      {
        type: 'input',
        block_id: 'title',
        label: { type: 'plain_text', text: 'Title' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          max_length: 255,
          ...(firstLine ? { initial_value: cutText(firstLine, 255) } : {}),
        },
      },
      {
        type: 'input',
        block_id: 'description',
        optional: true,
        label: { type: 'plain_text', text: 'Description' },
        hint: { type: 'plain_text', text: 'A link to the Slack message is added at the end.' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          multiline: true,
          max_length: 3000,
          ...(text ? { initial_value: cutText(text, 3000) } : {}),
        },
      },
    ],
  };
}

/** Post a short ephemeral answer through a shortcut's response_url (only to Slack's own hooks host). */
async function respond(c, responseUrl, text) {
  let u;
  try {
    u = new URL(String(responseUrl || ''));
  } catch {
    return;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'hooks.slack.com') return;
  const fetchFn = c.env.fetch || fetch;
  try {
    await fetchFn(u.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text }),
    });
  } catch (e) {
    console.error('slack: response_url failed', e);
  }
}

async function permalinkFor(c, cfg, channel, ts) {
  try {
    const r = await slackApi(c, 'chat.getPermalink', { channel, message_ts: ts }, cfg.token);
    if (r.permalink) return r.permalink;
  } catch (e) {
    if (!(e instanceof SlackError)) throw e;
  }
  if (cfg.teamUrl && /^[CGD][A-Z0-9]+$/.test(channel) && /^\d+\.\d+$/.test(ts))
    return `${cfg.teamUrl.replace(/\/$/, '')}/archives/${channel}/p${ts.replace('.', '')}`;
  return null;
}

async function onShortcut(c, cfg, p) {
  const say = (text) => defer(c, respond(c, p.response_url, text));
  const user = await trackerUser(c, cfg, p.user?.id);
  if (!user) {
    say(NO_MATCH);
    return c.body(null, 200);
  }
  actAs(c, user);
  const projects = await creatableProjects(c.env.db, user);
  if (!projects.length) {
    say('You cannot create issues in any project in the tracker.');
    return c.body(null, 200);
  }
  const meta = { channel: p.channel?.id || null, ts: p.message?.ts || p.message_ts || null };
  try {
    await slackApi(c, 'views.open', { trigger_id: p.trigger_id, view: createModal(projects, p.message, meta) }, cfg.token);
  } catch (e) {
    if (!(e instanceof SlackError)) throw e;
    await logSlackError(c.env.db, e.method, e.code, 'open the Create issue window');
    say('Could not open the Create issue window. Try again in a moment.');
  }
  return c.body(null, 200);
}

async function onSubmit(c, cfg, p) {
  const errors = (block, text) => c.json({ response_action: 'errors', errors: { [block]: text } });
  const user = await trackerUser(c, cfg, p.user?.id);
  if (!user) return errors('project', NO_MATCH);
  actAs(c, user);
  const v = p.view?.state?.values || {};
  const projectKey = v.project?.value?.selected_option?.value || '';
  const type = v.type?.value?.selected_option?.value || 'task';
  const title = String(v.title?.value?.value || '').trim();
  let description = String(v.description?.value?.value || '').trim();
  let meta = {};
  try {
    meta = JSON.parse(p.view?.private_metadata || '{}') || {};
  } catch {
    meta = {};
  }
  if (!projectKey) return errors('project', 'Choose a project');
  if (!title) return errors('title', 'Enter a title');
  const permalink = meta.channel && meta.ts ? await permalinkFor(c, cfg, meta.channel, meta.ts) : null;
  if (permalink) description = `${description}${description ? '\n\n' : ''}From Slack: ${permalink}`;
  let issue;
  try {
    issue = await createIssue(c, {
      projectKey,
      type: CREATE_TYPES.includes(type) ? type : 'task',
      title: title.slice(0, 255),
      description: description || null,
    });
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    const block = /title/i.test(e.message) ? 'title' : /type|parent/i.test(e.message) ? 'type' : 'project';
    return errors(block, e.status === 404 ? 'Project not found, or you cannot see it' : e.message);
  }
  const origin = publicOrigin(c);
  const text = `Created ${link(origin, issue.key)} ${slackText(issue.title)}`;
  // confirmation: ephemeral in the channel; when that is not possible (for example the app is not in it), a direct message
  defer(
    c,
    (async () => {
      try {
        if (!meta.channel) throw new SlackError('chat.postEphemeral', 'no_channel');
        await slackApi(c, 'chat.postEphemeral', { channel: meta.channel, user: p.user.id, text }, cfg.token);
      } catch (e) {
        if (!(e instanceof SlackError)) throw e;
        try {
          await slackApi(c, 'chat.postMessage', { channel: p.user.id, text, unfurl_links: false }, cfg.token);
        } catch (e2) {
          if (!(e2 instanceof SlackError)) throw e2;
          await logSlackError(c.env.db, e2.method, e2.code, `confirm ${issue.key}`);
        }
      }
    })(),
  );
  return c.json({ response_action: 'clear' });
}

export function registerSlackCommands(app) {
  app.post('/slack/commands', async (c) => {
    const raw = await c.req.text();
    const form = new URLSearchParams(raw);
    const b = await begin(c, raw, form.get('team_id'));
    if (b.res) return b.res;
    if (b.off) return ephemeral(c, OFF);
    if (b.otherTeam) return ephemeral(c, OTHER_TEAM);
    const user = await trackerUser(c, b.cfg, form.get('user_id'));
    if (!user) return ephemeral(c, NO_MATCH);
    actAs(c, user);
    return ephemeral(c, await runCommand(c, user, form.get('text') || ''));
  });

  app.post('/slack/interactivity', async (c) => {
    const raw = await c.req.text();
    let p;
    try {
      p = JSON.parse(new URLSearchParams(raw).get('payload') || 'null');
    } catch {
      p = null;
    }
    const b = await begin(c, raw, p?.team?.id || p?.user?.team_id);
    if (b.res) return b.res;
    if (!p || typeof p !== 'object') return c.text('Bad payload', 400);
    if (b.off || b.otherTeam) {
      if (p.type === 'view_submission') return c.json({ response_action: 'errors', errors: { project: b.off ? OFF : OTHER_TEAM } });
      defer(c, respond(c, p.response_url, b.off ? OFF : OTHER_TEAM));
      return c.body(null, 200);
    }
    if (p.type === 'message_action' && p.callback_id === SHORTCUT_CALLBACK) return onShortcut(c, b.cfg, p);
    if (p.type === 'view_submission' && p.view?.callback_id === VIEW_CALLBACK) return onSubmit(c, b.cfg, p);
    return c.body(null, 200); // other interactions: nothing to do
  });
}
