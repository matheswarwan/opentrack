// The due_reminders job: once a day, each person hears about their open issues that are overdue or due by tomorrow
// and the RAID entries they own that are due for review. At most one reminder per person and local day.
import { addDays, daysBetween } from '../time.js';
import { slackText } from '../slack.js';
import { escHtml, htmlEmail } from '../email.js';
import { visibleProjectsSql } from '../access.js';
import { issueFilter } from '../issues/search.js';
import { dueRaid, raidLabel } from '../raid.js';
import { on, sentToday, notify, slackDm, email } from './people.js';

/** Open issues assigned to the user (that they can still see) due by `until`, oldest due date first. */
export async function dueIssues(db, user, until, limit = 50) {
  const f = issueFilter(user, { assignee: 'me', category: 'todo,in_progress', dueBefore: until });
  return db.all(
    `SELECT i.key, i.title, i.due_date FROM issues i JOIN projects p ON p.id = i.project_id JOIN statuses s ON s.id = i.status_id
      WHERE ${f.where} ORDER BY i.due_date, p.key, i.number LIMIT ?`,
    [...f.params, limit],
  );
}

export function dueWord(due, today) {
  const d = daysBetween(today, due);
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d < 0) return `overdue ${-d} day${d === -1 ? '' : 's'}`;
  return `in ${d} days`;
}

/** The one-line in-app message: "3 issues due soon: WEB-12 (today), WEB-15 (tomorrow), BC-4 (overdue 2 days)". */
export function dueMessage(issues, today) {
  const shown = issues.slice(0, 8).map((i) => `${i.key} (${dueWord(i.due_date, today)})`);
  const more = issues.length > shown.length ? `, and ${issues.length - shown.length} more` : '';
  return `${issues.length} issue${issues.length === 1 ? '' : 's'} due soon: ${shown.join(', ')}${more}`;
}

/** RAID entries to review, as one line: "2 RAID entries to review: WEB RAID-3 (today), OPS RAID-1 (overdue 2 days)". */
export function raidMessage(entries, today) {
  const shown = entries.slice(0, 5).map((r) => `${raidLabel(r)} (${dueWord(r.review_date, today)})`);
  const more = entries.length > shown.length ? `, and ${entries.length - shown.length} more` : '';
  return `${entries.length} RAID ${entries.length === 1 ? 'entry' : 'entries'} to review: ${shown.join(', ')}${more}`;
}

/** One person's reminder: handle(ctx, user) for forEachPerson. */
export async function remindUser(ctx, u) {
  const today = ctx.parts.date;
  const tomorrow = addDays(today, 1);
  const who = { id: u.id, role: u.role };
  const issues = await dueIssues(ctx.db, who, tomorrow);
  // RAID entries they own with a review date by tomorrow (guests never own or see RAID entries)
  const raid = u.role === 'guest' ? [] : await dueRaid(ctx.db, who, tomorrow, visibleProjectsSql(who));
  if (!issues.length && !raid.length) return null;
  if (await sentToday(ctx, u.id, 'due')) return null;
  const message = [issues.length ? dueMessage(issues, today) : '', raid.length ? raidMessage(raid, today) : ''].filter(Boolean).join('. ');
  await notify(ctx, u.id, 'due', message);
  const link = issues.length
    ? `${ctx.origin}/issues?assignee=me&category=todo,in_progress&dueBefore=${tomorrow}`
    : `${ctx.origin}/projects/${raid[0].project_key}/raid?owner=me`;
  const out = { notified: true };
  if (on(u.due_slack)) {
    const lines = issues
      .slice(0, 20)
      .map((i) => `• <${ctx.origin}/browse/${i.key}|${i.key}> ${slackText(i.title)} (${dueWord(i.due_date, today)})`);
    if (issues.length > 20) lines.push(`and ${issues.length - 20} more`);
    for (const r of raid)
      lines.push(
        `• <${ctx.origin}/projects/${r.project_key}/raid?owner=me|${raidLabel(r)}> ${slackText(r.title)} (review ${dueWord(r.review_date, today)})`,
      );
    out.slack = await slackDm(
      ctx,
      u.id,
      [`*${slackText(message.split(':')[0])}*`, ...lines, `<${link}|Open them in the tracker>`].join('\n'),
      'due-date reminder',
    );
  }
  if (on(u.due_email))
    out.email = await email(ctx, u, dueEmail({ issues, raid, today, link, origin: ctx.origin, appName: ctx.appName }), 'due');
  return out;
}

export function dueEmail({ issues, raid = [], today, link, origin, appName }) {
  const n = issues.length;
  const subject = n
    ? `${n} issue${n === 1 ? '' : 's'} due soon`
    : `${raid.length} RAID ${raid.length === 1 ? 'entry' : 'entries'} to review`;
  const lines = n
    ? [
        `These open issues assigned to you are overdue or due by tomorrow:`,
        ...issues.slice(0, 50).map((i) => `${i.key} (${dueWord(i.due_date, today)}): ${i.title}`),
      ]
    : [];
  if (n > 50) lines.push(`and ${n - 50} more`);
  if (raid.length)
    lines.push(
      `RAID entries you own that are due for review:`,
      ...raid.map((r) => `${raidLabel(r)} (${dueWord(r.review_date, today)}): ${r.title}`),
    );
  const prefs = `${origin}/profile`;
  const text = [...lines, '', `Open them: ${link}`, '', '--', `${appName} sends this once a day. Turn it off under Profile: ${prefs}`].join(
    '\n',
  );
  const html = htmlEmail({
    lines,
    link,
    linkText: 'Open them in the tracker',
    footer: `${escHtml(appName)} sends this once a day. <a href="${escHtml(prefs)}">Turn it off under Profile</a>.`,
  });
  return { subject, text, html };
}
