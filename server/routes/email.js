// Email settings: personal notification preferences, the admin status card and test email,
// and invite / reset link emails (used by routes/admin.js).
import { body, fail } from '../lib/http.js';
import { now } from '../lib/crypto.js';
import { requireAdmin } from '../lib/session.js';
import { getSettings } from '../lib/settings.js';
import { emailConfigured, emailPrefs, sendEmail, inviteEmail, logEmailError, escHtml, EMAIL_TYPES } from '../lib/email.js';

/**
 * Email an invite or reset link. Returns { emailed: true } or { emailed: false, emailError }.
 * Never throws: the link is still shown to the admin either way.
 */
export async function emailInviteLink(c, user, invite, reset) {
  try {
    const settings = await getSettings(c.env.db);
    const msg = inviteEmail({
      appName: settings.appName,
      adminName: c.get('user').name,
      name: user.name,
      link: invite.link,
      expiresAt: invite.expiresAt,
      reset,
    });
    await sendEmail(c.env, { to: user.email, ...msg, tag: reset ? 'reset' : 'invite' });
    return { emailed: true };
  } catch (e) {
    await logEmailError(c.env.db, reset ? 'reset' : 'invite', e.message, user.email);
    return { emailed: false, emailError: e.message };
  }
}

export function registerEmail(app) {
  app.get('/api/me/email', async (c) => {
    const row = await c.env.db.get('SELECT * FROM email_prefs WHERE user_id = ?', [c.get('user').id]);
    return c.json({ configured: emailConfigured(c.env), prefs: emailPrefs(row) });
  });

  app.put('/api/me/email', async (c) => {
    const b = await body(c);
    const db = c.env.db;
    const uid = c.get('user').id;
    const prefs = emailPrefs(await db.get('SELECT * FROM email_prefs WHERE user_id = ?', [uid]));
    for (const t of EMAIL_TYPES) {
      if (b[t] === undefined) continue;
      if (typeof b[t] !== 'boolean') fail(400, `${t} must be true or false`);
      prefs[t] = b[t];
    }
    await db.run(
      `INSERT INTO email_prefs (user_id, on_assigned, on_mentioned, on_comment, on_status, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET on_assigned = excluded.on_assigned, on_mentioned = excluded.on_mentioned,
         on_comment = excluded.on_comment, on_status = excluded.on_status, updated_at = excluded.updated_at`,
      [uid, prefs.assigned ? 1 : 0, prefs.mentioned ? 1 : 0, prefs.comment ? 1 : 0, prefs.status ? 1 : 0, now()],
    );
    return c.json({ configured: emailConfigured(c.env), prefs });
  });

  app.get('/api/admin/email', async (c) => {
    requireAdmin(c);
    const errors = await c.env.db.all('SELECT kind, error, context, created_at FROM email_errors ORDER BY created_at DESC LIMIT 20');
    return c.json({
      configured: emailConfigured(c.env),
      from: c.env.EMAIL_FROM || null,
      stream: c.env.POSTMARK_STREAM || 'outbound',
      errors: errors.map((e) => ({ kind: e.kind, error: e.error, context: e.context, createdAt: e.created_at })),
    });
  });

  app.post('/api/admin/email/test', async (c) => {
    requireAdmin(c);
    if (!emailConfigured(c.env)) fail(400, 'Email is not configured. Set POSTMARK_SERVER_TOKEN and EMAIL_FROM on the server.');
    const user = c.get('user');
    const settings = await getSettings(c.env.db);
    try {
      await sendEmail(c.env, {
        to: user.email,
        subject: `Test email from ${settings.appName}`,
        text: `This is a test email from ${settings.appName}. Email notifications work.`,
        html: `<p>This is a test email from ${escHtml(settings.appName)}. Email notifications work.</p>`,
        tag: 'test',
      });
    } catch (e) {
      await logEmailError(c.env.db, 'test', e.message, user.email);
      fail(502, `The test email failed: ${e.message}`);
    }
    return c.json({ ok: true, to: user.email });
  });
}
