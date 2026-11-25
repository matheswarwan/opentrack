// Jobs that go through people one by one (due-date reminders, the weekly digest): the loop with its cursor, and the
// three ways a person is told (in-app notification, Slack DM, email). The runner is server/lib/jobs.js.
import { noticeStmts } from '../notifications.js';
import { localMidnight, addDays } from '../time.js';
import { slackConfig, slackApi, SlackError, logSlackError, slackUserFor } from '../slack.js';
import { emailConfigured, sendEmail, logEmailError } from '../email.js';

/** The numbers a people job counts, as its result starts. */
export const PEOPLE_COUNTS = { people: 0, notified: 0, slack: 0, email: 0 };

/**
 * A job's run that calls handle(ctx, user) for every active person, in id order, a batch at a time. It stops with
 * 'partial' when room() says so and leaves the last person's id in ctx.cursor, where the next slice continues.
 * handle returns { notified, slack, email } (or null), which are counted.
 */
export function forEachPerson(handle) {
  return async function run(ctx, counts, room) {
    ctx.cursor = ctx.resume;
    ctx.slack = await slackConfig({ env: ctx.env });
    ctx.emailOn = emailConfigured(ctx.env);
    for (;;) {
      if (!room()) return { status: 'partial' };
      const users = await ctx.db.all(
        `SELECT u.id, u.email, u.name, u.role, r.due_slack, r.due_email, r.digest_slack, r.digest_email
           FROM users u LEFT JOIN reminder_prefs r ON r.user_id = u.id
          WHERE u.status = 'active' AND u.is_system = 0${ctx.cursor ? ' AND u.id > ?' : ''} ORDER BY u.id LIMIT ?`,
        ctx.cursor ? [ctx.cursor, ctx.lim.batch] : [ctx.lim.batch],
      );
      if (!users.length) break;
      for (const u of users) {
        if (!room()) return { status: 'partial' };
        const r = await handle(ctx, u);
        ctx.cursor = u.id;
        counts.people += 1;
        if (r?.notified) counts.notified += 1;
        if (r?.slack) counts.slack += 1;
        if (r?.email) counts.email += 1;
      }
      if (users.length < ctx.lim.batch) break;
    }
    return { status: 'done' };
  };
}

// ---- delivery helpers ----

/** A reminder preference: on unless the person turned it off (no row yet counts as on). */
export const on = (v) => v === null || v === undefined || Boolean(Number(v));

/** Already sent today's notification of this type? (The in-app one is written first, so this dedupes resumed runs.) */
export async function sentToday(ctx, userId, type) {
  const start = new Date(localMidnight(ctx.parts.date, ctx.tz)).toISOString();
  const end = new Date(localMidnight(addDays(ctx.parts.date, 1), ctx.tz)).toISOString();
  const row = await ctx.db.get('SELECT 1 AS x FROM notifications WHERE user_id = ? AND type = ? AND created_at >= ? AND created_at < ?', [
    userId,
    type,
    start,
    end,
  ]);
  return Boolean(row);
}

export async function notify(ctx, userId, type, message) {
  const [stmt] = noticeStmts([{ userId, type, message, at: new Date(ctx.nowMs).toISOString() }]);
  await ctx.db.run(stmt.sql, stmt.params);
}

export async function slackDm(ctx, userId, text, context) {
  if (!ctx.slack.active) return false;
  const c = { env: ctx.env };
  const call = async (method, params, why) => {
    try {
      return await slackApi(c, method, params, ctx.slack.token);
    } catch (e) {
      if (!(e instanceof SlackError)) throw e;
      if (e.code !== 'users_not_found') await logSlackError(ctx.db, method, e.code, why);
      return null;
    }
  };
  const slackId = await slackUserFor(c, userId, call);
  if (!slackId) return false;
  const open = await call('conversations.open', { users: slackId }, context);
  const channel = open?.channel?.id;
  if (!channel) return false;
  const fallback = text.replace(/<[^|>]+\|([^>]+)>/g, '$1').replace(/\*/g, '');
  const r = await call(
    'chat.postMessage',
    {
      channel,
      text: fallback.slice(0, 300),
      unfurl_links: false,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2950) } }],
    },
    context,
  );
  return Boolean(r);
}

export async function email(ctx, user, msg, tag) {
  if (!ctx.emailOn) return false;
  try {
    await sendEmail(ctx.env, { to: user.email, ...msg, tag });
    return true;
  } catch (e) {
    await logEmailError(ctx.db, tag, e.message, user.email);
    return false;
  }
}
