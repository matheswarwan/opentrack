// Security (migration 0033): a person's sessions and two-factor sign-in (Profile), and the admin actions on
// another person (reset two-factor, sign out everywhere). The second sign-in step itself is in routes/auth.js.
import { body, fail } from '../lib/http.js';
import { sha256, now, verifyPassword } from '../lib/crypto.js';
import { requireAdmin } from '../lib/session.js';
import { audit } from '../lib/audit.js';
import { getSettings } from '../lib/settings.js';
import { clock } from '../lib/time.js';
import {
  newSecret,
  otpauthUri,
  matchingStep,
  newRecoveryCodes,
  recoveryCodesLeft,
  checkSecondFactor,
  clearTwoFactor,
  tooManyFailures,
  recordFailure,
  describeAgent,
} from '../lib/twofactor.js';

function requireSession(c) {
  if (c.get('authVia') !== 'session') fail(403, 'This is only available in the web app, not with an API token');
}

/** Statement that signs a person out everywhere except the session making this request (if it is theirs). */
export function revokeOtherSessions(c, userId) {
  const keep = c.get('authVia') === 'session' && c.get('user')?.id === userId ? c.get('sessionId') : null;
  return keep
    ? { sql: 'DELETE FROM sessions WHERE user_id = ? AND id <> ?', params: [userId, keep] }
    : { sql: 'DELETE FROM sessions WHERE user_id = ?', params: [userId] };
}

/**
 * Proof that the person at the keyboard is the account owner: a current code, a recovery code, or the password.
 * Wrong answers count toward the sign-in lockout.
 */
async function requireProof(c, b) {
  const db = c.env.db;
  const u = await db.get('SELECT id, email, password_hash, totp_secret, totp_enabled_at FROM users WHERE id = ?', [c.get('user').id]);
  if (await tooManyFailures(db, u.email)) fail(429, 'Too many failed attempts. Try again in 15 minutes.');
  let ok = false;
  if (b.code !== undefined && b.code !== '' && u.totp_enabled_at) ok = Boolean(await checkSecondFactor(db, c.env, u, b.code));
  else if (typeof b.password === 'string' && b.password) ok = await verifyPassword(b.password, u.password_hash);
  else fail(400, 'Enter a code from your authenticator app, a recovery code, or your password');
  if (!ok) {
    await recordFailure(db, u.email);
    fail(400, b.code ? 'That code is wrong or was already used' : 'Password is wrong');
  }
  return u;
}

export function registerSecurity(app) {
  // ---- sessions ----
  app.get('/api/me/sessions', async (c) => {
    requireSession(c);
    const rows = await c.env.db.all(
      'SELECT id, created_at, last_seen_at, expires_at, user_agent FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC',
      [c.get('user').id, now()],
    );
    const current = c.get('sessionId');
    const sessions = [];
    for (const r of rows) {
      sessions.push({
        id: await sha256(r.id), // the stored id is the hash of the cookie; the page gets a hash of that
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at || r.created_at,
        expiresAt: r.expires_at,
        browser: describeAgent(r.user_agent),
        userAgent: r.user_agent || '',
        current: r.id === current,
      });
    }
    sessions.sort((a, b) => Number(b.current) - Number(a.current) || (a.lastSeenAt < b.lastSeenAt ? 1 : -1));
    return c.json({ sessions, idleTimeoutMinutes: (await getSettings(c.env.db)).idleTimeoutMinutes });
  });

  // Sign out everywhere else. (Before /:id so the word is not taken for an id.)
  app.post('/api/me/sessions/revoke-others', async (c) => {
    requireSession(c);
    const r = await c.env.db.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', [c.get('user').id, c.get('sessionId')]);
    return c.json({ ok: true, count: r.changes });
  });

  app.delete('/api/me/sessions/:id', async (c) => {
    requireSession(c);
    const db = c.env.db;
    const rows = await db.all('SELECT id FROM sessions WHERE user_id = ?', [c.get('user').id]);
    let found = null;
    for (const r of rows) if ((await sha256(r.id)) === c.req.param('id')) found = r.id;
    if (!found) fail(404, 'Session not found');
    await db.run('DELETE FROM sessions WHERE id = ?', [found]);
    return c.json({ ok: true, current: found === c.get('sessionId') });
  });

  // ---- two-factor sign-in ----
  app.get('/api/me/2fa', async (c) => {
    requireSession(c);
    const db = c.env.db;
    const u = await db.get('SELECT password_hash, totp_enabled_at FROM users WHERE id = ?', [c.get('user').id]);
    return c.json({
      enabled: Boolean(u.totp_enabled_at),
      enabledAt: u.totp_enabled_at || null,
      hasPassword: Boolean(u.password_hash),
      recoveryCodesLeft: u.totp_enabled_at ? await recoveryCodesLeft(db, c.get('user').id) : 0,
      required: Boolean(c.get('twoFactorSetupRequired')),
    });
  });

  // Step 1: make a secret. Nothing is on until a code confirms it.
  app.post('/api/me/2fa/setup', async (c) => {
    requireSession(c);
    const db = c.env.db;
    const u = await db.get('SELECT id, email, password_hash, totp_enabled_at FROM users WHERE id = ?', [c.get('user').id]);
    if (u.totp_enabled_at) fail(409, 'Two-factor sign-in is already on');
    if (!u.password_hash)
      fail(
        400,
        'Two-factor sign-in protects password sign-in. You sign in with Google, which has its own two-step verification. Set a password first if you want to use it.',
      );
    const secret = newSecret();
    await db.run('UPDATE users SET totp_secret = ?, totp_last_step = NULL, updated_at = ? WHERE id = ?', [secret, now(), u.id]);
    return c.json({ secret, uri: otpauthUri((await getSettings(db)).appName, u.email, secret) });
  });

  // Step 2: a code from the app turns it on. The recovery codes are returned once.
  app.post('/api/me/2fa/confirm', async (c) => {
    requireSession(c);
    const db = c.env.db;
    const b = await body(c);
    const u = await db.get('SELECT id, email, totp_secret, totp_enabled_at FROM users WHERE id = ?', [c.get('user').id]);
    if (u.totp_enabled_at) fail(409, 'Two-factor sign-in is already on');
    if (!u.totp_secret) fail(400, 'Start the setup first');
    if (await tooManyFailures(db, u.email)) fail(429, 'Too many failed attempts. Try again in 15 minutes.');
    const step = await matchingStep(u.totp_secret, b.code, clock(c.env));
    if (step === null) {
      await recordFailure(db, u.email);
      fail(400, 'That code is not right. Check the time on your phone and try the next code.');
    }
    const rc = await newRecoveryCodes(u.id);
    await db.batch([
      { sql: 'UPDATE users SET totp_enabled_at = ?, totp_last_step = ?, updated_at = ? WHERE id = ?', params: [now(), step, now(), u.id] },
      ...rc.stmts,
      audit(u.id, 'user.2fa_enabled', 'user', u.id),
    ]);
    return c.json({ ok: true, recoveryCodes: rc.codes });
  });

  // Turn it off: needs a current code, a recovery code or the password. Other sessions are signed out.
  app.post('/api/me/2fa/disable', async (c) => {
    requireSession(c);
    const db = c.env.db;
    const cur = await db.get('SELECT totp_enabled_at FROM users WHERE id = ?', [c.get('user').id]);
    if (!cur.totp_enabled_at) {
      await db.batch(clearTwoFactor(c.get('user').id)); // drops a setup that was started and not confirmed
      return c.json({ ok: true });
    }
    const u = await requireProof(c, await body(c));
    await db.batch([...clearTwoFactor(u.id), revokeOtherSessions(c, u.id), audit(u.id, 'user.2fa_disabled', 'user', u.id)]);
    return c.json({ ok: true });
  });

  // New recovery codes (the old ones stop working): same proof as turning it off.
  app.post('/api/me/2fa/recovery-codes', async (c) => {
    requireSession(c);
    const db = c.env.db;
    const cur = await db.get('SELECT totp_enabled_at FROM users WHERE id = ?', [c.get('user').id]);
    if (!cur.totp_enabled_at) fail(400, 'Two-factor sign-in is off');
    const u = await requireProof(c, await body(c));
    const rc = await newRecoveryCodes(u.id);
    await db.batch([...rc.stmts, audit(u.id, 'user.2fa_recovery_codes', 'user', u.id)]);
    return c.json({ ok: true, recoveryCodes: rc.codes });
  });

  // ---- admin: another person ----
  async function target(c) {
    requireAdmin(c);
    const user = await c.env.db.get('SELECT id, name, totp_enabled_at FROM users WHERE id = ? AND is_system = 0', [c.req.param('id')]);
    if (!user) fail(404, 'User not found');
    return user;
  }

  // Reset two-factor (lost phone): turns it off and signs the person out. They sign in with their password and can set it up again.
  app.post('/api/admin/users/:id/2fa/reset', async (c) => {
    const user = await target(c);
    if (!user.totp_enabled_at) fail(400, `${user.name} does not have two-factor sign-in on`);
    await c.env.db.batch([
      ...clearTwoFactor(user.id),
      revokeOtherSessions(c, user.id),
      audit(c.get('user').id, 'user.2fa_reset', 'user', user.id),
    ]);
    return c.json({ ok: true });
  });

  // Sign out everywhere (web sessions; API tokens and connected apps are managed on their own page).
  app.post('/api/admin/users/:id/sessions/revoke', async (c) => {
    const user = await target(c);
    const db = c.env.db;
    const n = await db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM sessions WHERE user_id = ?', [user.id]);
    const own = user.id === c.get('user').id; // your own current session stays
    await db.batch([
      revokeOtherSessions(c, user.id),
      audit(c.get('user').id, 'user.signed_out_everywhere', 'user', user.id, { sessions: Math.max(0, Number(n.n) - (own ? 1 : 0)) }),
    ]);
    return c.json({ ok: true, count: Math.max(0, Number(n.n) - (own ? 1 : 0)) });
  });
}
