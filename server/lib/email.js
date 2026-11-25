// Email: one send function (Postmark today), notification emails and invite emails.
// Email is on only when POSTMARK_SERVER_TOKEN and EMAIL_FROM are set. Notification emails go out in the
// background after the database commit (like Slack): they never fail or slow the request, and failures are
// logged to email_errors (about 50 rows kept).
// To add another provider later, branch inside sendEmail() on an env var; everything else stays the same.
import { uuid, now } from './crypto.js';
import { placeholders } from '../db/sql.js';
import { defer, publicOrigin } from './http.js';

const ERROR_ROWS = 50;
export const MAX_RECIPIENTS = 50; // per request, so one change can never send hundreds of emails
export const EMAIL_TYPES = ['assigned', 'mentioned', 'comment', 'status'];
export const EMAIL_DEFAULTS = { assigned: true, mentioned: true, comment: false, status: false };

export class EmailError extends Error {}

export function emailConfigured(env) {
  return Boolean(env.POSTMARK_SERVER_TOKEN && env.EMAIL_FROM);
}

/** Send one email. Throws EmailError when it is not configured or the provider refuses it. */
export async function sendEmail(env, { to, subject, text, html, tag }) {
  if (!emailConfigured(env)) throw new EmailError('Email is not configured');
  const fetchFn = env.fetch || fetch;
  let res;
  try {
    res = await fetchFn('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'X-Postmark-Server-Token': env.POSTMARK_SERVER_TOKEN },
      body: JSON.stringify({
        From: env.EMAIL_FROM,
        To: to,
        Subject: subject,
        TextBody: text,
        ...(html ? { HtmlBody: html } : {}),
        ...(tag ? { Tag: tag } : {}),
        MessageStream: env.POSTMARK_STREAM || 'outbound',
      }),
    });
  } catch {
    throw new EmailError('Could not reach Postmark');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok || (data && data.ErrorCode)) {
    throw new EmailError(`Postmark error ${data?.ErrorCode ?? res.status}: ${data?.Message || res.statusText || 'request failed'}`);
  }
  return data;
}

export async function logEmailError(db, kind, error, context) {
  try {
    await db.batch([
      {
        sql: 'INSERT INTO email_errors (id, kind, error, context, created_at) VALUES (?, ?, ?, ?, ?)',
        params: [uuid(), kind, String(error).slice(0, 300), context ? String(context).slice(0, 300) : null, now()],
      },
      {
        sql: `DELETE FROM email_errors WHERE id NOT IN (SELECT id FROM email_errors ORDER BY created_at DESC LIMIT ${ERROR_ROWS})`,
        params: [],
      },
    ]);
  } catch (e) {
    console.error('email: could not log error', e);
  }
}

// ---- text helpers ----

const MENTION_RE = /@\[([^\]]{1,100})\]\(user:[0-9a-f-]{36}\)/g;

/** Markdown to readable plain text: mentions as @Name, links as "text (url)", markup removed. */
export function plainText(md) {
  return String(md || '')
    .replace(MENTION_RE, '@$1')
    .replace(/```[^\n]*\n?/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, t, u) => (t === u ? u : `${t} (${u})`))
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^(\s*)[*+]\s+/gm, '$1- ')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/<[^>\n]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const escHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Minimal HTML version of a plain email: escaped paragraphs, one link, a small footer. */
export function htmlEmail({ lines, quote, linkText, link, footer }) {
  const p = (t) => `<p style="margin:0 0 12px">${escHtml(t).replace(/\n/g, '<br>')}</p>`;
  return [
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f2937">',
    ...lines.map(p),
    quote
      ? `<blockquote style="margin:0 0 12px;padding-left:12px;border-left:3px solid #d1d5db;color:#374151">${escHtml(quote).replace(/\n/g, '<br>')}</blockquote>`
      : '',
    link ? `<p style="margin:0 0 12px"><a href="${escHtml(link)}">${escHtml(linkText || link)}</a></p>` : '',
    footer ? `<p style="margin:24px 0 0;font-size:12px;color:#6b7280">${footer}</p>` : '',
    '</div>',
  ].join('');
}

// ---- background delivery ----

/**
 * Email the in-app notifications that the batch that just committed wrote: `records` are its notices
 * (lib/notifications.js), so email follows whatever the in-app rules decided.
 * extra: { text } the comment or description that holds the mention, { status: { from, to } } for moves.
 */
export function emailNotify(c, records, extra = {}) {
  try {
    if (!emailConfigured(c.env)) return;
    const items = [];
    for (const { userId, type, issueId, actorId } of records || []) {
      if (EMAIL_TYPES.includes(type) || type === 'reply') items.push({ userId, type, issueId, actorId });
    }
    if (!items.length) return;
    const actor = c.get('user');
    defer(c, deliver(c, items, { ...extra, actor: { id: actor.id, name: actor.name }, origin: publicOrigin(c) }), {
      label: 'email delivery failed',
      queue: c.env.emailQueue || c.env.slackQueue,
    });
  } catch (e) {
    console.error('email: could not schedule', e);
  }
}

async function deliver(c, items, ev) {
  const db = c.env.db;
  const ids = [...new Set(items.map((i) => i.userId))];
  const users = await db.all(
    `SELECT u.id, u.email, u.name, u.status, e.on_assigned, e.on_mentioned, e.on_comment, e.on_status
       FROM users u LEFT JOIN email_prefs e ON e.user_id = u.id WHERE u.id IN (${placeholders(ids.length)})`,
    ids,
  );
  const byId = new Map(users.map((u) => [u.id, u]));
  const issues = new Map();
  let sent = 0;
  const seen = new Set();
  for (const item of items) {
    const u = byId.get(item.userId);
    const self = u && (u.id === ev.actor.id || u.id === item.actorId);
    if (!u || u.status !== 'active' || (self && item.type !== 'mentioned')) continue; // a self-mention emails you too
    if (!emailPrefs(u)[item.type === 'reply' ? 'mentioned' : item.type]) continue; // replies follow the "mentions me" choice
    if (seen.has(`${u.id}:${item.issueId}`)) continue; // one email per person and issue per change
    seen.add(`${u.id}:${item.issueId}`);
    if (sent >= MAX_RECIPIENTS) {
      await logEmailError(
        db,
        'notification',
        `Skipped: more than ${MAX_RECIPIENTS} recipients in one change`,
        `${item.type} for ${u.email}`,
      );
      continue;
    }
    if (!issues.has(item.issueId)) {
      issues.set(item.issueId, await db.get('SELECT i.key, i.title FROM issues i WHERE i.id = ? AND i.deleted_at IS NULL', [item.issueId]));
    }
    const issue = issues.get(item.issueId);
    if (!issue) continue;
    const msg = notificationEmail({
      type: item.type,
      issue,
      actorName: ev.actor.name,
      text: ev.text,
      status: ev.status,
      origin: ev.origin,
    });
    sent++;
    try {
      await sendEmail(c.env, { to: u.email, ...msg, tag: item.type });
    } catch (e) {
      await logEmailError(db, 'notification', e.message, `${item.type} ${issue.key} to ${u.email}`);
    }
  }
}

/** Preferences from an email_prefs row (or a users row joined with it); missing row = defaults. */
export function emailPrefs(row) {
  if (!row || row.on_assigned === null || row.on_assigned === undefined) return { ...EMAIL_DEFAULTS };
  return {
    assigned: Boolean(Number(row.on_assigned)),
    mentioned: Boolean(Number(row.on_mentioned)),
    comment: Boolean(Number(row.on_comment)),
    status: Boolean(Number(row.on_status)),
  };
}

/** Subject, text and HTML for one notification email. */
export function notificationEmail({ type, issue, actorName, text, status, origin }) {
  const title = cut(String(issue.title || ''), 150);
  const subjects = {
    assigned: `${actorName} assigned you`,
    mentioned: `${actorName} mentioned you`,
    comment: `${actorName} commented`,
    reply: `${actorName} replied to a comment`,
    status: `${actorName} moved it to ${status?.to || 'a new status'}`,
  };
  const subject = `[${issue.key}] ${subjects[type]}: ${title}`;
  const link = `${origin}/browse/${issue.key}`;
  const lines = [];
  if (type === 'assigned') lines.push(`${actorName} assigned ${issue.key} to you: ${issue.title}`);
  if (type === 'mentioned') lines.push(`${actorName} mentioned you in ${issue.key}: ${issue.title}`);
  if (type === 'comment') lines.push(`${actorName} commented on ${issue.key}: ${issue.title}`);
  if (type === 'reply') lines.push(`${actorName} replied in a comment thread you are in on ${issue.key}: ${issue.title}`);
  if (type === 'status')
    lines.push(
      `${actorName} moved ${issue.key} ${status?.from ? `from ${status.from} ` : ''}to ${status?.to || 'a new status'}: ${issue.title}`,
    );
  const quote = (type === 'mentioned' || type === 'comment' || type === 'reply') && text ? cut(plainText(text), 3000) : '';
  const prefs = `${origin}/profile`;
  const textBody = [
    ...lines,
    ...(quote ? ['', quote] : []),
    '',
    `Open the issue: ${link}`,
    '',
    '--',
    `You get this email because of your notification settings. Change them here: ${prefs}`,
  ].join('\n');
  const html = htmlEmail({
    lines,
    quote,
    linkText: `Open ${issue.key}`,
    link,
    footer: `You get this email because of your notification settings. <a href="${escHtml(prefs)}">Change them</a>.`,
  });
  return { subject, text: textBody, html };
}

/** Invite or password reset email. */
export function inviteEmail({ appName, adminName, name, link, expiresAt, reset }) {
  const until = new Date(expiresAt).toUTCString().replace(/:\d\d GMT$/, ' UTC');
  const subject = reset ? `Reset your password for ${appName}` : `You are invited to ${appName}`;
  const lines = reset
    ? [`Hi ${name},`, `${adminName} created a link for you to set a new password for ${appName}. It works once and expires ${until}.`]
    : [
        `Hi ${name},`,
        `${adminName} added you to ${appName}. Use this link to set your password and sign in. It works once and expires ${until}.`,
      ];
  const text = [...lines, '', link, '', 'If you did not expect this email, you can ignore it.'].join('\n');
  const html = htmlEmail({
    lines,
    link,
    linkText: reset ? 'Set a new password' : 'Accept the invite',
    footer: 'If you did not expect this email, you can ignore it.',
  });
  return { subject, text, html };
}
