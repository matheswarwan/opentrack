// The weekly digest: what /digest shows (buildDigest) and what the weekly_digest job sends by Slack and email.
import { localParts, addDays } from '../time.js';
import { slackText } from '../slack.js';
import { escHtml, htmlEmail } from '../email.js';
import { visibleProjectsSql, commentVisibleSql, historyVisibleSql } from '../access.js';
import { issueFilter } from '../issues/search.js';
import { dueWord } from './reminders.js';
import { on, sentToday, notify, slackDm, email } from './people.js';

/**
 * Digest content for one person (what /digest shows and the weekly job sends). Only projects they can see.
 * 4 queries. `user` needs id and role (and projectScope for a scoped token).
 */
export async function buildDigest(db, user, { nowMs, tz }) {
  const parts = localParts(nowMs, tz);
  const today = parts.date;
  const weekEnd = addDays(today, 6);
  const since = new Date(nowMs - 7 * 864e5).toISOString();
  const open = issueFilter(user, { assignee: 'me', category: 'todo,in_progress' });
  const watched = issueFilter(user, { watching: '1' });
  const v = visibleProjectsSql(user);
  // guests: internal notes and their history rows are left out (lib/access.js)
  const changedBy = `FROM issue_history h WHERE h.issue_id = i.id AND h.created_at >= ? AND (h.actor_id IS NULL OR h.actor_id <> ?)${historyVisibleSql(user)}`;
  const commentedBy = `FROM comments cm WHERE cm.issue_id = i.id AND cm.created_at >= ? AND cm.deleted_at IS NULL AND (cm.author_id IS NULL OR cm.author_id <> ?)${commentVisibleSql(user)}`;
  const [openRows, totalRow, watchedRows, mentions] = await Promise.all([
    db.all(
      `SELECT i.key, i.title, i.priority, i.due_date, s.name AS status_name, s.category, s.position, p.key AS project_key
         FROM issues i JOIN projects p ON p.id = i.project_id JOIN statuses s ON s.id = i.status_id
        WHERE ${open.where} ORDER BY i.due_date IS NULL, i.due_date, p.key, i.number LIMIT 200`,
      open.params,
    ),
    db.get(
      `SELECT CAST(COUNT(*) AS INTEGER) AS n FROM issues i JOIN projects p ON p.id = i.project_id JOIN statuses s ON s.id = i.status_id WHERE ${open.where}`,
      open.params,
    ),
    db.all(
      `SELECT i.key, i.title, s.name AS status_name, s.category,
              (SELECT CAST(COUNT(*) AS INTEGER) ${changedBy}) AS changes,
              (SELECT CAST(COUNT(*) AS INTEGER) ${commentedBy}) AS comments
         FROM issues i JOIN projects p ON p.id = i.project_id JOIN statuses s ON s.id = i.status_id
        WHERE ${watched.where} AND (EXISTS (SELECT 1 ${changedBy}) OR EXISTS (SELECT 1 ${commentedBy}))
        ORDER BY i.updated_at DESC LIMIT 50`,
      [since, user.id, since, user.id, ...watched.params, since, user.id, since, user.id],
    ),
    db.all(
      `SELECT n.message, n.created_at, i.key, i.title, a.name AS actor_name
         FROM notifications n JOIN issues i ON i.id = n.issue_id JOIN projects p ON p.id = i.project_id LEFT JOIN users a ON a.id = n.actor_id
        WHERE n.user_id = ? AND n.type = 'mentioned' AND n.created_at >= ? AND i.deleted_at IS NULL AND p.archived = 0 AND ${v.sql}
        ORDER BY n.created_at DESC LIMIT 30`,
      [user.id, since, ...v.params],
    ),
  ]);
  const byStatus = new Map();
  for (const r of openRows) {
    const k = r.status_name;
    if (!byStatus.has(k)) byStatus.set(k, { status: k, category: r.category, count: 0 });
    byStatus.get(k).count += 1;
  }
  const issue = (r) => ({
    key: r.key,
    title: r.title,
    status: r.status_name,
    category: r.category,
    priority: r.priority,
    dueDate: r.due_date,
  });
  return {
    today,
    weekEnd,
    since,
    timeZone: tz,
    open: {
      total: totalRow?.n ?? openRows.length,
      byStatus: [...byStatus.values()].sort((a, b) =>
        a.category === b.category ? b.count - a.count : a.category === 'in_progress' ? -1 : 1,
      ),
      issues: openRows.slice(0, 100).map(issue),
    },
    overdue: openRows.filter((r) => r.due_date && r.due_date < today).map((r) => ({ ...issue(r), due: dueWord(r.due_date, today) })),
    dueThisWeek: openRows
      .filter((r) => r.due_date && r.due_date >= today && r.due_date <= weekEnd)
      .map((r) => ({ ...issue(r), due: dueWord(r.due_date, today) })),
    watched: watchedRows.map((r) => ({
      key: r.key,
      title: r.title,
      status: r.status_name,
      changes: Number(r.changes) || 0,
      comments: Number(r.comments) || 0,
    })),
    mentions: mentions.map((m) => ({ key: m.key, title: m.title, by: m.actor_name || null, at: m.created_at })),
  };
}

export function digestEmpty(d) {
  return !d.open.total && !d.watched.length && !d.mentions.length;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Plain lines shared by the email and Slack versions. keyFn renders an issue key (a link in Slack). */
function digestSections(d, keyFn, esc = (s) => s) {
  const out = [];
  const status = d.open.byStatus.map((s) => `${esc(s.status)} ${s.count}`).join(', ');
  out.push({ head: `Open issues assigned to you: ${d.open.total}${status ? ` (${status})` : ''}`, items: [] });
  if (d.overdue.length)
    out.push({
      head: `Overdue (${d.overdue.length})`,
      items: d.overdue.slice(0, 10).map((i) => `${keyFn(i.key)} ${esc(i.title)} (${i.due})`),
      more: d.overdue.length - 10,
    });
  if (d.dueThisWeek.length)
    out.push({
      head: `Due in the next 7 days (${d.dueThisWeek.length})`,
      items: d.dueThisWeek.slice(0, 10).map((i) => `${keyFn(i.key)} ${esc(i.title)} (${i.due})`),
      more: d.dueThisWeek.length - 10,
    });
  if (d.watched.length) {
    out.push({
      head: `Issues you watch that changed this week (${d.watched.length})`,
      items: d.watched
        .slice(0, 10)
        .map(
          (w) =>
            `${keyFn(w.key)} ${esc(w.title)}: ${[w.changes ? plural(w.changes, 'change') : '', w.comments ? plural(w.comments, 'comment') : ''].filter(Boolean).join(', ')}`,
        ),
      more: d.watched.length - 10,
    });
  }
  if (d.mentions.length)
    out.push({
      head: `Mentions (${d.mentions.length})`,
      items: d.mentions.slice(0, 10).map((m) => `${keyFn(m.key)} ${esc(m.title)}${m.by ? ` (by ${esc(m.by)})` : ''}`),
      more: d.mentions.length - 10,
    });
  return out;
}

export function digestEmail(d, { origin, appName }) {
  const link = `${origin}/digest`;
  const prefs = `${origin}/profile`;
  const lines = [];
  for (const s of digestSections(d, (k) => k)) {
    lines.push([s.head, ...s.items.map((i) => `- ${i}`), ...(s.more > 0 ? [`- and ${s.more} more`] : [])].join('\n'));
  }
  const subject = `Your weekly digest: ${plural(d.open.total, 'open issue')}${d.overdue.length ? `, ${d.overdue.length} overdue` : ''}`;
  const text = [
    `Your week in ${appName}`,
    '',
    ...lines.flatMap((l) => [l, '']),
    `See it in the tracker: ${link}`,
    '',
    '--',
    `Sent every week. Turn it off under Profile: ${prefs}`,
  ].join('\n');
  const html = htmlEmail({
    lines: [`Your week in ${appName}`, ...lines],
    link,
    linkText: 'Open your digest',
    footer: `Sent every week. <a href="${escHtml(prefs)}">Turn it off under Profile</a>.`,
  });
  return { subject, text, html };
}

export function digestSlack(d, { origin }) {
  const lines = ['*Your weekly digest*'];
  for (const s of digestSections(d, (k) => `<${origin}/browse/${k}|${k}>`, slackText)) {
    lines.push(`*${s.head}*`, ...s.items.map((i) => `• ${i}`), ...(s.more > 0 ? [`and ${s.more} more`] : []));
  }
  lines.push(`<${origin}/digest|Open your digest>`);
  return lines.join('\n');
}

/** One person's digest: handle(ctx, user) for forEachPerson. */
export async function digestUser(ctx, u) {
  const d = await buildDigest(ctx.db, { id: u.id, role: u.role }, { nowMs: ctx.nowMs, tz: ctx.tz });
  if (digestEmpty(d)) return null;
  if (await sentToday(ctx, u.id, 'digest')) return null;
  await notify(ctx, u.id, 'digest', 'Your weekly digest is ready');
  const out = { notified: true };
  if (on(u.digest_slack)) out.slack = await slackDm(ctx, u.id, digestSlack(d, ctx), 'weekly digest');
  if (on(u.digest_email)) out.email = await email(ctx, u, digestEmail(d, ctx), 'digest');
  return out;
}
