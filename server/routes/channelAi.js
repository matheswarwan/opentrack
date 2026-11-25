// Channel AI sessions: project channels (Project settings > Channels), channel links on issues with a "who is who"
// prompt, the AI session switch, Run now, and the AI's suggested changes (Apply / Dismiss). See server/lib/channelAi.js.
// Registered from registerIssues so that Apply goes through updateIssue (history, notifications, Slack and email).
import { body, fail, str, oneOf } from '../lib/http.js';
import { parseJson } from '../lib/json.js';
import { uuid, now } from '../lib/crypto.js';
import { requireAdmin, requireNotGuest } from '../lib/session.js';
import { audit } from '../lib/audit.js';
import { projectAccess } from '../lib/access.js';
import { getSettings } from '../lib/settings.js';
import { slackConfig } from '../lib/slack.js';
import { aiStatus } from '../lib/ai.js';
import { clock } from '../lib/time.js';
import { parseSlackLink } from './slack.js';
import { loadIssue } from '../lib/issues/guards.js';
import { updateIssue } from '../lib/issues/write.js';
import {
  CHANNEL_KINDS,
  LOW_RISK,
  LINK_SELECT,
  sessionBlock,
  processLink,
  channelAiState,
  ensureAiUser,
  applyLowRisk,
  auditStmt,
} from '../lib/channelAi.js';

const MAX_PROJECT_CHANNELS = 30;
const MAX_LINKS_PER_ISSUE = 10;
const CHANNEL_RE = /^[CG][A-Z0-9]{2,30}$/;

function notForGuests(c) {
  if (c.get('user').role === 'guest') fail(404, 'Not found'); // the Slack workspace and its channels are internal
}

function linkOut(l, { canAdmin, canEdit, userId }) {
  const mine = Boolean(l.created_by) && l.created_by === userId;
  return {
    id: l.id,
    projectChannelId: l.project_channel_id,
    channel: { id: l.channel_id, name: l.channel_name, kind: l.kind },
    threadTs: l.thread_ts,
    permalink: l.permalink,
    prompt: l.prompt || '',
    sessionOn: Boolean(Number(l.session_on)),
    autoApply: Boolean(Number(l.auto_apply)),
    lastRunAt: l.last_run_at,
    lastStatus: l.last_status,
    lastResult: parseJson(l.last_result),
    lastError: l.last_error,
    createdBy: l.created_by ? { id: l.created_by, name: l.created_by_name || null } : null,
    createdAt: l.created_at,
    canEditPrompt: canEdit && (canAdmin || mine),
    canRemove: canEdit && (canAdmin || mine),
  };
}

const suggestionOut = (s) => ({
  id: s.id,
  linkId: s.link_id,
  kind: s.kind,
  value: s.value,
  reason: s.reason,
  channel: s.channel_name || null,
  createdAt: s.created_at,
});

const channelOut = (pc) => ({
  id: pc.id,
  channelId: pc.channel_id,
  name: pc.channel_name,
  kind: pc.kind,
  links: Number(pc.links || 0),
  createdAt: pc.created_at,
});

/** A link, its issue and the caller's rights (guests: 404). */
async function loadLink(c, id, need = 'view') {
  notForGuests(c);
  const link = await c.env.db.get(`${LINK_SELECT} WHERE l.id = ?`, [id]);
  if (!link) fail(404, 'Channel link not found');
  const { row, access, rights } = await loadIssue(c, link.issue_id, need);
  return { link, row, access, rights, canAdmin: access.canAdmin && !access.project.archived };
}

async function projectChannel(c, id) {
  const pc = await c.env.db.get('SELECT * FROM project_channels WHERE id = ?', [id]);
  if (!pc) fail(404, 'Channel not found');
  const a = await projectAccess(c, pc.project_id, 'admin');
  return { pc, a };
}

export function registerChannelAi(app) {
  // ---- workspace (admins) ----
  app.get('/api/admin/ai', async (c) => {
    requireAdmin(c);
    const errors = await c.env.db.all('SELECT provider, error, context, created_at FROM ai_errors ORDER BY created_at DESC LIMIT 50');
    return c.json({
      ...aiStatus(c.env),
      errors: errors.map((e) => ({ provider: e.provider, error: e.error, context: e.context, at: e.created_at })),
    });
  });

  app.delete('/api/admin/ai/errors', async (c) => {
    requireAdmin(c);
    await c.env.db.run('DELETE FROM ai_errors');
    return c.json({ ok: true });
  });

  // ---- project channels ----
  app.get('/api/projects/:key/channels', async (c) => {
    notForGuests(c);
    const a = await projectAccess(c, c.req.param('key'), 'view');
    const rows = await c.env.db.all(
      `SELECT pc.id, pc.channel_id, pc.channel_name, pc.kind, pc.created_at, CAST(COUNT(l.id) AS INTEGER) AS links
         FROM project_channels pc LEFT JOIN channel_links l ON l.project_channel_id = pc.id
        WHERE pc.project_id = ? GROUP BY pc.id, pc.channel_id, pc.channel_name, pc.kind, pc.created_at ORDER BY pc.channel_name, pc.channel_id`,
      [a.project.id],
    );
    return c.json({ channels: rows.map(channelOut), canAdmin: a.canAdmin, state: await channelAiState(c) });
  });

  app.post('/api/projects/:key/channels', async (c) => {
    const a = await projectAccess(c, c.req.param('key'), 'admin');
    const db = c.env.db;
    const b = await body(c);
    if (typeof b.channelId !== 'string' || !CHANNEL_RE.test(b.channelId)) fail(400, 'Choose a channel from the list');
    const name = str(b.channelName, { max: 100, name: 'Channel name' }) || null;
    const kind = oneOf(b.kind || 'internal', CHANNEL_KINDS, 'Kind');
    if (!(await slackConfig(c)).active) fail(409, 'Slack is not connected or is turned off. An admin can set it up under Admin > Slack.');
    const n = await db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM project_channels WHERE project_id = ?', [a.project.id]);
    if (n.n >= MAX_PROJECT_CHANNELS) fail(400, `A project can have up to ${MAX_PROJECT_CHANNELS} channels`);
    if (await db.get('SELECT id FROM project_channels WHERE project_id = ? AND channel_id = ?', [a.project.id, b.channelId]))
      fail(409, 'That channel is already linked to this project');
    const id = uuid();
    await db.batch([
      {
        sql: 'INSERT INTO project_channels (id, project_id, channel_id, channel_name, kind, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        params: [id, a.project.id, b.channelId, name, kind, c.get('user').id, now()],
      },
      audit(c.get('user').id, 'project.channel_added', 'project', a.project.id, { channelId: b.channelId, channelName: name, kind }),
    ]);
    return c.json({ channel: channelOut({ id, channel_id: b.channelId, channel_name: name, kind, links: 0, created_at: now() }) }, 201);
  });

  app.patch('/api/project-channels/:id', async (c) => {
    const { pc } = await projectChannel(c, c.req.param('id'));
    const kind = oneOf((await body(c)).kind, CHANNEL_KINDS, 'Kind');
    if (kind && kind !== pc.kind) {
      await c.env.db.batch([
        { sql: 'UPDATE project_channels SET kind = ? WHERE id = ?', params: [kind, pc.id] },
        audit(c.get('user').id, 'project.channel_updated', 'project', pc.project_id, {
          channelId: pc.channel_id,
          channelName: pc.channel_name,
          kind,
        }),
      ]);
    }
    return c.json({ channel: channelOut({ ...pc, kind: kind || pc.kind }) });
  });

  app.delete('/api/project-channels/:id', async (c) => {
    const { pc } = await projectChannel(c, c.req.param('id'));
    const n = await c.env.db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM channel_links WHERE project_channel_id = ?', [pc.id]);
    await c.env.db.batch([
      { sql: 'DELETE FROM project_channels WHERE id = ?', params: [pc.id] }, // its issue links go with it
      audit(c.get('user').id, 'project.channel_removed', 'project', pc.project_id, {
        channelId: pc.channel_id,
        channelName: pc.channel_name,
        links: n.n,
      }),
    ]);
    return c.json({ ok: true, linksRemoved: n.n });
  });

  // ---- links on an issue ----
  app.get('/api/issues/:key/channels', async (c) => {
    notForGuests(c);
    const { row, access, rights } = await loadIssue(c, c.req.param('key'));
    const db = c.env.db;
    const user = c.get('user');
    const canEdit = rights.canEdit && user.role !== 'viewer';
    const canAdmin = access.canAdmin && !access.project.archived;
    const [links, suggestions, channels] = await Promise.all([
      db.all(
        `SELECT l.*, pc.channel_id, pc.channel_name, pc.kind, u.name AS created_by_name FROM channel_links l
           JOIN project_channels pc ON pc.id = l.project_channel_id LEFT JOIN users u ON u.id = l.created_by
          WHERE l.issue_id = ? ORDER BY l.created_at`,
        [row.id],
      ),
      db.all(
        `SELECT s.*, pc.channel_name FROM ai_suggestions s LEFT JOIN channel_links l ON l.id = s.link_id LEFT JOIN project_channels pc ON pc.id = l.project_channel_id
          WHERE s.issue_id = ? AND s.status = 'pending' ORDER BY s.created_at`,
        [row.id],
      ),
      db.all(
        'SELECT id, channel_id, channel_name, kind, created_at FROM project_channels WHERE project_id = ? ORDER BY channel_name, channel_id',
        [row.project_id],
      ),
    ]);
    return c.json({
      links: links.map((l) => linkOut(l, { canAdmin, canEdit, userId: user.id })),
      suggestions: suggestions.map(suggestionOut),
      channels: channels.map(channelOut),
      canLink: canEdit,
      canAdmin,
      canApply: canEdit,
      state: await channelAiState(c),
    });
  });

  app.post('/api/issues/:key/channels', async (c) => {
    requireNotGuest(c, 'link Slack channels');
    const { row } = await loadIssue(c, c.req.param('key'), 'edit');
    const db = c.env.db;
    const b = await body(c);
    const pc = b.projectChannelId
      ? await db.get('SELECT * FROM project_channels WHERE id = ? AND project_id = ?', [b.projectChannelId, row.project_id])
      : null;
    if (!pc) fail(400, "Choose one of the project's channels. Project admins add them under Project settings > Channels.");
    let threadTs = null;
    let permalink = null;
    if (b.messageUrl) {
      const l = parseSlackLink(b.messageUrl);
      if (!l) fail(400, 'That is not a Slack message link. In Slack, open the message menu and choose Copy link.');
      if (l.channel !== pc.channel_id) fail(400, `That message is not in #${pc.channel_name || pc.channel_id}`);
      threadTs = l.threadTs || l.ts;
      permalink = l.permalink;
    }
    const prompt = str(b.prompt, { max: 3000, name: 'Who is who' }) || null;
    const n = await db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM channel_links WHERE issue_id = ?', [row.id]);
    if (n.n >= MAX_LINKS_PER_ISSUE) fail(400, `An issue can have up to ${MAX_LINKS_PER_ISSUE} channel links`);
    const dup = await db.get(`SELECT id FROM channel_links WHERE issue_id = ? AND project_channel_id = ? AND COALESCE(thread_ts, '') = ?`, [
      row.id,
      pc.id,
      threadTs || '',
    ]);
    if (dup) fail(409, threadTs ? 'That thread is already linked to this issue' : 'That channel is already linked to this issue');
    const id = uuid();
    const t = now();
    const user = c.get('user');
    await db.batch([
      {
        sql: `INSERT INTO channel_links (id, issue_id, project_channel_id, thread_ts, permalink, prompt, session_on, auto_apply, created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
        params: [id, row.id, pc.id, threadTs, permalink, prompt, user.id, t, t],
      },
      audit(user.id, 'channel_link.created', 'issue', row.id, {
        issue: row.key,
        channel: pc.channel_name || pc.channel_id,
        kind: pc.kind,
        thread: Boolean(threadTs),
      }),
    ]);
    const link = await db.get(`${LINK_SELECT} WHERE l.id = ?`, [id]);
    const { access } = await loadIssue(c, row.id);
    return c.json(
      {
        link: linkOut(
          { ...link, created_by_name: user.name },
          { canAdmin: access.canAdmin && !access.project.archived, canEdit: true, userId: user.id },
        ),
      },
      201,
    );
  });

  app.patch('/api/channel-links/:id', async (c) => {
    const { link, row, rights, canAdmin } = await loadLink(c, c.req.param('id'));
    const db = c.env.db;
    const user = c.get('user');
    const b = await body(c);
    const canEdit = rights.canEdit && user.role !== 'viewer';
    const sets = {};
    const audits = [];
    if (b.prompt !== undefined) {
      if (!canEdit || !(canAdmin || link.created_by === user.id))
        fail(403, 'Only project admins and the person who linked the channel can change the prompt');
      sets.prompt = str(b.prompt, { max: 3000, name: 'Who is who' }) || null;
      audits.push(
        audit(user.id, 'channel_link.prompt_changed', 'issue', row.id, {
          issue: row.key,
          link: link.id,
          length: (sets.prompt || '').length,
        }),
      );
    }
    for (const [field, col, on, off] of [
      ['sessionOn', 'session_on', 'channel_ai.session_on', 'channel_ai.session_off'],
      ['autoApply', 'auto_apply', 'channel_ai.auto_apply_on', 'channel_ai.auto_apply_off'],
    ]) {
      if (b[field] === undefined) continue;
      if (typeof b[field] !== 'boolean') fail(400, `${field} must be true or false`);
      if (!canAdmin)
        fail(403, field === 'sessionOn' ? 'Only project admins can turn the AI session on or off' : 'Only project admins can change this');
      if (b[field] === Boolean(Number(link[col]))) continue;
      if (field === 'sessionOn' && b[field]) {
        const block = sessionBlock({ env: c.env, settings: await getSettings(db), slack: await slackConfig(c), link });
        if (block) fail(409, block);
      }
      sets[col] = b[field] ? 1 : 0;
      audits.push(
        audit(user.id, b[field] ? on : off, 'issue', row.id, {
          issue: row.key,
          link: link.id,
          channel: link.channel_name || link.channel_id,
          kind: link.kind,
        }),
      );
    }
    const cols = Object.keys(sets);
    if (cols.length) {
      await db.batch([
        {
          sql: `UPDATE channel_links SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
          params: [...cols.map((k) => sets[k]), now(), link.id],
        },
        ...audits,
      ]);
    }
    const fresh = await db.get(
      `${LINK_SELECT.replace('FROM channel_links l', ', u.name AS created_by_name FROM channel_links l')} LEFT JOIN users u ON u.id = l.created_by WHERE l.id = ?`,
      [link.id],
    );
    return c.json({ link: linkOut(fresh, { canAdmin, canEdit, userId: user.id }) });
  });

  app.delete('/api/channel-links/:id', async (c) => {
    const { link, row, rights, canAdmin } = await loadLink(c, c.req.param('id'));
    const user = c.get('user');
    if (!rights.canEdit || user.role === 'viewer' || !(canAdmin || link.created_by === user.id))
      fail(403, 'Only project admins and the person who linked the channel can remove it');
    await c.env.db.batch([
      {
        sql: `UPDATE ai_suggestions SET status = 'dismissed', decided_by = ?, decided_at = ? WHERE link_id = ? AND status = 'pending'`,
        params: [user.id, now(), link.id],
      },
      { sql: 'DELETE FROM channel_links WHERE id = ?', params: [link.id] },
      audit(user.id, 'channel_link.removed', 'issue', row.id, {
        issue: row.key,
        channel: link.channel_name || link.channel_id,
        kind: link.kind,
      }),
    ]);
    return c.json({ ok: true });
  });

  // Run the session for this link now (project admins). Works whether the session is on or off.
  app.post('/api/channel-links/:id/run', async (c) => {
    const { link, canAdmin, rights } = await loadLink(c, c.req.param('id'));
    if (!canAdmin) fail(403, 'Only project admins can run the AI session');
    const db = c.env.db;
    const settings = await getSettings(db);
    const slack = await slackConfig(c);
    const block = sessionBlock({ env: c.env, settings, slack, link });
    if (block) fail(409, block);
    const result = await processLink({ env: c.env, db, nowMs: clock(c.env), slack, settings }, link);
    await db.batch([
      audit(c.get('user').id, 'channel_ai.run', 'issue', link.issue_id, { issue: link.issue_key, link: link.id, status: result.status }),
    ]);
    const fresh = await db.get(
      `${LINK_SELECT.replace('FROM channel_links l', ', u.name AS created_by_name FROM channel_links l')} LEFT JOIN users u ON u.id = l.created_by WHERE l.id = ?`,
      [link.id],
    );
    return c.json({
      result: {
        status: result.status,
        messages: result.messages || 0,
        suggestions: result.suggestions || 0,
        autoApplied: result.autoApplied || 0,
        error: result.error || null,
      },
      link: linkOut(fresh, { canAdmin, canEdit: rights.canEdit, userId: c.get('user').id }),
    });
  });

  // ---- suggestions ----
  async function loadSuggestion(c) {
    notForGuests(c);
    const s = await c.env.db.get('SELECT * FROM ai_suggestions WHERE id = ?', [c.req.param('id')]);
    if (!s) fail(404, 'Suggestion not found');
    const { row, access } = await loadIssue(c, s.issue_id, 'edit');
    if (c.get('user').role === 'viewer') fail(403, 'Viewers cannot make changes');
    if (s.status !== 'pending') fail(409, s.status === 'applied' ? 'This suggestion was already applied' : 'This suggestion was dismissed');
    return { s, row, access };
  }

  async function claim(c, s, status) {
    const r = await c.env.db.run(
      `UPDATE ai_suggestions SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'`,
      [status, c.get('user').id, now(), s.id],
    );
    if (r.changes !== 1) fail(409, 'Someone else just decided on this suggestion');
  }

  app.post('/api/ai-suggestions/:id/apply', async (c) => {
    const { s, row, access } = await loadSuggestion(c);
    const db = c.env.db;
    const user = c.get('user');
    if (s.kind === 'subtask' && !access.canCreate) fail(403, 'You cannot create issues in this project');
    await claim(c, s, 'applied');
    let details = {};
    try {
      if (s.kind === 'status') await updateIssue(c, row.key, { statusId: s.target });
      else if (s.kind === 'assignee') await updateIssue(c, row.key, { assigneeId: s.target });
      else if (s.kind === 'dueDate') await updateIssue(c, row.key, { dueDate: s.target });
      else if (s.kind === 'priority') await updateIssue(c, row.key, { priority: s.target });
      else if (LOW_RISK.includes(s.kind))
        details = await applyLowRisk(db, row, s, { id: user.id, name: user.name }, (await ensureAiUser(db)).id);
      else fail(400, 'Unknown suggestion');
    } catch (e) {
      await db.run(`UPDATE ai_suggestions SET status = 'pending', decided_by = NULL, decided_at = NULL WHERE id = ?`, [s.id]);
      throw e;
    }
    await db.batch([auditStmt(user.id, 'ai_suggestion.applied', s, row, details)]);
    return c.json({ ok: true, kind: s.kind, ...details });
  });

  app.post('/api/ai-suggestions/:id/dismiss', async (c) => {
    const { s, row } = await loadSuggestion(c);
    await claim(c, s, 'dismissed');
    await c.env.db.batch([auditStmt(c.get('user').id, 'ai_suggestion.dismissed', s, row)]);
    return c.json({ ok: true });
  });
}
