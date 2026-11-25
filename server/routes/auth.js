import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { fontConfig } from './fonts.js';
import { body, fail, str, EMAIL_RE, publicOrigin } from '../lib/http.js';
import { hashPassword, verifyPassword, sha256, now, uuid, randomToken, safeEqual, avatarColor, b64urlDecode } from '../lib/crypto.js';
import { startSession, endSession, currentUser } from '../lib/session.js';
import { audit } from '../lib/audit.js';
import { getSettings, domainAllowed } from '../lib/settings.js';
import { demoEnabled, DEMO_EMAIL, DEMO_NAME } from '../lib/demo.js';
import { startChallenge, challengeUser, checkSecondFactor, tooManyFailures, recordFailure, recoveryCodesLeft } from '../lib/twofactor.js';

export const MIN_PASSWORD = 10;

export function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) fail(400, `Password must be at least ${MIN_PASSWORD} characters`);
  if (pw.length > 200) fail(400, 'Password is too long');
}

function googleEnabled(env) {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

/** A same-site path to return to after sign-in (e.g. the OAuth consent page), or null. */
function localPath(p) {
  return typeof p === 'string' && p.length <= 4000 && p.startsWith('/') && !p.startsWith('//') && !p.startsWith('/\\') ? p : null;
}

/**
 * The password (or invite link) was right. With two-factor on, no session yet: the answer carries a pending token
 * (5 minutes) and the browser sends it back with a code to POST /api/auth/login/2fa. Otherwise the session starts.
 * `user` needs id and totp_enabled_at.
 */
async function finishSignIn(c, user) {
  if (user.totp_enabled_at) return { ok: true, twoFactor: true, pendingToken: await startChallenge(c.env.db, user.id) };
  await startSession(c, user);
  return { ok: true };
}

export function registerAuth(app) {
  app.get('/api/auth/config', async (c) => {
    const db = c.env.db;
    const s = await getSettings(db);
    const anyUser = await db.get('SELECT id FROM users LIMIT 1');
    return c.json({
      appName: s.appName,
      needsSetup: !anyUser,
      google: googleEnabled(c.env),
      passwordLogin: s.passwordLogin || !googleEnabled(c.env),
      demo: demoEnabled(c.env),
      fonts: await fontConfig(db, s),
    });
  });

  // First admin. Only works while there are no users and needs the SETUP_TOKEN secret.
  app.post('/api/auth/setup', async (c) => {
    const db = c.env.db;
    const b = await body(c);
    if (!c.env.SETUP_TOKEN) fail(403, 'Setup is turned off (no SETUP_TOKEN configured)');
    if (!safeEqual(String(b.token || ''), c.env.SETUP_TOKEN)) fail(403, 'Wrong setup token');
    if (await db.get('SELECT id FROM users LIMIT 1')) fail(409, 'Setup is already done');
    const email = str(b.email, { required: true, max: 200, name: 'Email' }).toLowerCase();
    if (!EMAIL_RE.test(email)) fail(400, 'Email is not valid');
    const name = str(b.name, { required: true, max: 100, name: 'Name' });
    checkPassword(b.password);
    const user = { id: uuid(), email, name };
    await db.batch([
      {
        sql: `INSERT INTO users (id, email, name, role, status, password_hash, avatar_color, created_at, updated_at)
              VALUES (?, ?, ?, 'admin', 'active', ?, ?, ?, ?)`,
        params: [user.id, email, name, await hashPassword(b.password), avatarColor(email), now(), now()],
      },
      audit(user.id, 'setup.first_admin', 'user', user.id, { email }),
    ]);
    await startSession(c, user);
    return c.json({ ok: true });
  });

  app.post('/api/auth/login', async (c) => {
    const db = c.env.db;
    const b = await body(c);
    const settings = await getSettings(db);
    if (!settings.passwordLogin && googleEnabled(c.env)) fail(403, 'Password sign-in is turned off. Use Google.');
    const email = String(b.email || '')
      .trim()
      .toLowerCase();
    if (await tooManyFailures(db, email)) fail(429, 'Too many failed attempts. Try again in 15 minutes.');
    const user = await db.get(
      'SELECT id, email, name, status, password_hash, totp_enabled_at FROM users WHERE email = ? AND is_system = 0',
      [email],
    );
    const ok = user && user.status === 'active' && (await verifyPassword(String(b.password || ''), user.password_hash));
    if (!ok) {
      await recordFailure(db, email);
      fail(401, 'Email or password is wrong');
    }
    // With two-factor on, the failure count is cleared only after the code: a right password must not reset
    // the count of wrong codes.
    if (!user.totp_enabled_at) await db.run('DELETE FROM login_failures WHERE email = ?', [email]);
    return c.json(await finishSignIn(c, user));
  });

  // Public demo (lib/demo.js): signs the visitor in as the shared, read-only-admin demo account, made on first use.
  // Only after setup, so the first real admin is still made through /setup.
  app.post('/api/auth/demo', async (c) => {
    const db = c.env.db;
    if (!demoEnabled(c.env)) fail(404, 'The demo is not turned on');
    if (!(await db.get('SELECT id FROM users WHERE email <> ? LIMIT 1', [DEMO_EMAIL]))) fail(409, 'Finish setup first');
    await db.run(
      `INSERT INTO users (id, email, name, role, status, avatar_color, created_at, updated_at)
       SELECT ?, ?, ?, 'admin', 'active', ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = ?)`,
      [uuid(), DEMO_EMAIL, DEMO_NAME, avatarColor(DEMO_EMAIL), now(), now(), DEMO_EMAIL],
    );
    const user = await db.get('SELECT id, status FROM users WHERE email = ?', [DEMO_EMAIL]);
    if (user.status !== 'active') fail(403, 'The demo account is deactivated');
    await startSession(c, user);
    return c.json({ ok: true });
  });

  // Second step for people with two-factor on: the pending token from the first step plus a 6-digit code
  // (or a recovery code). Wrong codes count toward the same lockout as wrong passwords.
  app.post('/api/auth/login/2fa', async (c) => {
    const db = c.env.db;
    const b = await body(c);
    const user = await challengeUser(db, b.pendingToken);
    if (!user) fail(401, 'This sign-in has expired. Start again with your email and password.', { code: 'challenge_expired' });
    if (await tooManyFailures(db, user.email)) fail(429, 'Too many failed attempts. Try again in 15 minutes.');
    const how = await checkSecondFactor(db, c.env, user, b.code);
    if (!how) {
      await recordFailure(db, user.email);
      fail(401, 'That code is wrong or was already used');
    }
    await db.batch([
      { sql: 'DELETE FROM login_challenges WHERE user_id = ?', params: [user.id] },
      { sql: 'DELETE FROM login_failures WHERE email = ?', params: [user.email] },
    ]);
    await startSession(c, user);
    // after a recovery code: how many are left, so the page can say so
    return c.json({ ok: true, ...(how === 'recovery' ? { recoveryCodesLeft: await recoveryCodesLeft(db, user.id) } : {}) });
  });

  app.post('/api/auth/logout', async (c) => {
    await endSession(c);
    return c.json({ ok: true });
  });

  async function findInvite(db, token) {
    const row = await db.get(
      `SELECT i.token_hash, i.expires_at, i.used_at, u.id AS user_id, u.email, u.name, u.status, u.totp_enabled_at
         FROM invites i JOIN users u ON u.id = i.user_id WHERE i.token_hash = ?`,
      [await sha256(token)],
    );
    if (!row || row.used_at || row.status === 'deactivated') fail(404, 'This link is not valid or was already used');
    if (row.expires_at < now()) fail(410, 'This link has expired. Ask an admin for a new one.');
    return row;
  }

  app.get('/api/auth/invite/:token', async (c) => {
    const inv = await findInvite(c.env.db, c.req.param('token'));
    return c.json({ email: inv.email, name: inv.name, google: googleEnabled(c.env) });
  });

  // Accept an invite (or a password reset link): set the password and sign in.
  app.post('/api/auth/invite/:token', async (c) => {
    const db = c.env.db;
    const inv = await findInvite(db, c.req.param('token'));
    const b = await body(c);
    checkPassword(b.password);
    const name = str(b.name, { max: 100, name: 'Name' }) || inv.name;
    await db.batch([
      {
        sql: `UPDATE users SET password_hash = ?, name = ?, status = 'active', updated_at = ? WHERE id = ?`,
        params: [await hashPassword(b.password), name, now(), inv.user_id],
      },
      { sql: 'UPDATE invites SET used_at = ? WHERE token_hash = ?', params: [now(), inv.token_hash] },
      { sql: 'DELETE FROM sessions WHERE user_id = ?', params: [inv.user_id] },
      audit(inv.user_id, 'user.invite_accepted', 'user', inv.user_id),
    ]);
    // a reset link does not skip two-factor: with it on, the code is asked next
    return c.json(await finishSignIn(c, { id: inv.user_id, totp_enabled_at: inv.totp_enabled_at }));
  });

  // ---- Google sign-in (OpenID Connect, authorization code flow) ----
  app.get('/auth/google', async (c) => {
    if (!googleEnabled(c.env)) return c.text('Google sign-in is not configured', 404);
    const state = randomToken(16);
    const nonce = randomToken(16);
    const secure = new URL(c.req.url).protocol === 'https:';
    setCookie(c, 'it_oidc', `${state}.${nonce}`, { httpOnly: true, secure, sameSite: 'Lax', path: '/auth', maxAge: 600 });
    const next = localPath(c.req.query('next'));
    if (next) setCookie(c, 'it_next', next, { httpOnly: true, secure, sameSite: 'Lax', path: '/auth', maxAge: 600 });
    else deleteCookie(c, 'it_next', { path: '/auth' });
    const s = await getSettings(c.env.db);
    const domains = String(s.googleDomains || '')
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean);
    const p = new URLSearchParams({
      client_id: c.env.GOOGLE_CLIENT_ID,
      redirect_uri: `${publicOrigin(c)}/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      prompt: 'select_account',
    });
    if (domains.length === 1) p.set('hd', domains[0]);
    return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${p}`);
  });

  app.get('/auth/google/callback', async (c) => {
    const back = (msg) => c.redirect(`/login?error=${encodeURIComponent(msg)}`);
    if (!googleEnabled(c.env)) return back('Google sign-in is not configured');
    const [state, nonce] = String(getCookie(c, 'it_oidc') || '').split('.');
    deleteCookie(c, 'it_oidc', { path: '/auth' });
    if (!state || state !== c.req.query('state')) return back('Sign-in expired. Try again.');
    const code = c.req.query('code');
    if (!code) return back('Google did not return a sign-in code');
    const fetchFn = c.env.fetch || fetch;
    const res = await fetchFn('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: c.env.GOOGLE_CLIENT_ID,
        client_secret: c.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${publicOrigin(c)}/auth/google/callback`,
        grant_type: 'authorization_code',
      }),
    });
    if (!res.ok) return back('Google sign-in failed');
    const tok = await res.json();
    // The ID token came straight from Google's token endpoint over TLS, so its claims
    // can be trusted without checking the signature (OIDC Core 3.1.3.7).
    let claims;
    try {
      claims = JSON.parse(new TextDecoder().decode(b64urlDecode(String(tok.id_token).split('.')[1])));
    } catch {
      return back('Google sign-in failed');
    }
    const issOk = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
    if (!issOk || claims.aud !== c.env.GOOGLE_CLIENT_ID || claims.exp * 1000 < Date.now() || claims.nonce !== nonce) {
      return back('Google sign-in could not be verified');
    }
    if (!claims.email_verified) return back('Your Google email is not verified');
    const result = await googleUser(c.env.db, claims);
    if (result.error) return back(result.error);
    await startSession(c, result.user);
    const next = localPath(getCookie(c, 'it_next'));
    deleteCookie(c, 'it_next', { path: '/auth' });
    return c.redirect(next || '/');
  });
}

/** Match a Google identity to a provisioned user (or auto-provision when allowed). */
export async function googleUser(db, claims) {
  const email = String(claims.email || '').toLowerCase();
  const s = await getSettings(db);
  const domains = String(s.googleDomains || '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  const domain = email.split('@')[1] || '';
  if (domains.length && !domains.includes(domain) && !domains.includes(String(claims.hd || '').toLowerCase())) {
    return { error: `Accounts from ${domain} cannot sign in here` };
  }
  let user = await db.get('SELECT id, email, status, google_sub FROM users WHERE google_sub = ? AND is_system = 0', [claims.sub]);
  if (!user) user = await db.get('SELECT id, email, status, google_sub FROM users WHERE email = ? AND is_system = 0', [email]);
  if (user) {
    if (user.status === 'deactivated') return { error: 'Your account is deactivated. Ask an admin.' };
    if (user.google_sub && user.google_sub !== claims.sub) return { error: 'This email is linked to a different Google account' };
    await db.batch([
      { sql: `UPDATE users SET google_sub = ?, status = 'active', updated_at = ? WHERE id = ?`, params: [claims.sub, now(), user.id] },
      { sql: 'UPDATE invites SET used_at = ? WHERE user_id = ? AND used_at IS NULL', params: [now(), user.id] },
    ]);
    return { user };
  }
  if (!s.googleAutoProvision || !domains.length) return { error: 'You do not have an account yet. Ask an admin to add you.' };
  // Admin > Settings > Allowed email domains: no new account for an email outside the list
  if (!domainAllowed(s, email)) return { error: `Accounts from ${domain} cannot be created here. Ask an admin.` };
  const id = uuid();
  const name = String(claims.name || email.split('@')[0]).slice(0, 100);
  await db.batch([
    {
      sql: `INSERT INTO users (id, email, name, role, status, google_sub, avatar_color, created_at, updated_at)
            VALUES (?, ?, ?, 'member', 'active', ?, ?, ?, ?)`,
      params: [id, email, name, claims.sub, avatarColor(email), now(), now()],
    },
    audit(id, 'user.auto_provisioned', 'user', id, { email }),
  ]);
  return { user: { id, email } };
}

export { currentUser };
