import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { randomToken, sha256, now } from './crypto.js';
import { fail } from './http.js';
import { getSettings } from './settings.js';
import { parseJson } from './json.js';
import { isDemoUser, demoLocked, isWrite, DEMO_READ_ONLY } from './demo.js';

export const SESSION_COOKIE = 'it_session';
const SESSION_DAYS = 30;
/** sessions.last_seen_at is written at most this often per session (keeps requests cheap). */
export const SEEN_EVERY_MS = 5 * 60e3;
/** The web app sends this header on its own timers (the notification bell): such a request does not count as use. */
export const BACKGROUND_HEADER = 'x-background';

function secure(c) {
  return new URL(c.req.url).protocol === 'https:';
}

export async function startSession(c, user) {
  const db = c.env.db;
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  const id = await sha256(token);
  c.set('sessionId', id);
  await db.batch([
    {
      sql: 'INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
      params: [id, user.id, now(), expires, (c.req.header('user-agent') || '').slice(0, 300), now()],
    },
    { sql: 'UPDATE users SET last_login_at = ? WHERE id = ?', params: [now(), user.id] },
    { sql: 'DELETE FROM sessions WHERE expires_at < ?', params: [now()] },
  ]);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: secure(c),
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_DAYS * 86400,
  });
}

export async function endSession(c) {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.db.run('DELETE FROM sessions WHERE id = ?', [await sha256(token)]);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

const TOKEN_PREFIX = 'otk_';

/** The bearer token in the request, if it looks like one of ours. */
export function bearerToken(c) {
  const m = (c.req.header('authorization') || '').match(/^Bearer\s+(otk_[A-Za-z0-9_-]{20,100})$/);
  return m ? m[1] : null;
}

/** Parse api_tokens.project_scope: null = all projects, else an array of project ids. */
export function parseScope(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return []; // unreadable scope: allow nothing rather than everything
  }
}

/**
 * User from `Authorization: Bearer otk_...` (personal API token or OAuth access token), or null.
 * A scoped personal token sets `projectScope` (array of project ids) on the returned user;
 * lib/access.js hides every other project from it.
 */
export async function tokenUser(c) {
  const raw = bearerToken(c);
  if (!raw) return null;
  const db = c.env.db;
  const settings = await getSettings(db);
  if (!settings.apiTokens) return null;
  c.set('timeZone', settings.timeZone); // for today(c) in lib/time.js
  const row = await db.get(
    `SELECT u.id, u.email, u.name, u.title, u.role, u.status, u.avatar_color, t.id AS token_id, t.last_used_at,
            t.kind AS token_kind, t.prefix AS token_prefix, t.name AS token_name, t.project_scope, t.client_id, oc.client_name
       FROM api_tokens t JOIN users u ON u.id = t.user_id LEFT JOIN oauth_clients oc ON oc.client_id = t.client_id
      WHERE t.token_hash = ? AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > ?) AND u.status = 'active'
        AND u.role <> 'guest'`, // guests cannot use API tokens or AI connectors (OAuth), even ones made before they became guests
    [await sha256(raw), now()],
  );
  if (!row) return null;
  // OAuth tokens always reach every project the user can see.
  row.projectScope = row.token_kind === 'personal' ? parseScope(row.project_scope) : null;
  delete row.project_scope;
  // record use at most every 10 minutes
  if (!row.last_used_at || row.last_used_at < new Date(Date.now() - 600e3).toISOString()) {
    await db.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', [now(), row.token_id]);
  }
  return row;
}

export function newApiToken() {
  return TOKEN_PREFIX + randomToken(30);
}

/**
 * The signed-in user of the session cookie, or null. One statement: it also reads the two workspace settings it
 * needs (idleTimeoutMinutes, require2faAdmins) and the workspace time zone for today(c). Sets on the context: `sessionId`, and `twoFactorSetupRequired`
 * when the workspace requires two-factor for admins and this admin (with a password) has not turned it on.
 * Idle timeout: a session not used for idleTimeoutMinutes is removed. Use is recorded at most every 5 minutes
 * (SEEN_EVERY_MS), so the session ends between the timeout and the timeout plus 5 minutes after its last use.
 */
export async function currentUser(c) {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const db = c.env.db;
  const id = await sha256(token);
  const row = await db.get(
    `SELECT u.id, u.email, u.name, u.title, u.role, u.status, u.avatar_color,
            u.totp_enabled_at AS x_totp, CASE WHEN u.password_hash IS NULL THEN 0 ELSE 1 END AS x_has_password,
            s.created_at AS x_created, s.last_seen_at AS x_seen,
            (SELECT value FROM settings WHERE key = 'idleTimeoutMinutes') AS x_idle,
            (SELECT value FROM settings WHERE key = 'require2faAdmins') AS x_require,
            (SELECT value FROM settings WHERE key = 'timeZone') AS x_tz
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > ? AND u.status = 'active'`,
    [id, now()],
  );
  if (!row) return null;
  const idle = Number(parseJson(row.x_idle, 0)) || 0;
  const seen = row.x_seen || row.x_created;
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  if (idle > 0 && seen < ago(idle * 60e3 + SEEN_EVERY_MS)) {
    await db.run('DELETE FROM sessions WHERE id = ?', [id]);
    return null;
  }
  if (seen < ago(SEEN_EVERY_MS) && !c.req.header(BACKGROUND_HEADER))
    await db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [now(), id]);
  c.set('sessionId', id);
  c.set('timeZone', parseJson(row.x_tz, null)); // for today(c) in lib/time.js: no settings query later
  c.set(
    'twoFactorSetupRequired',
    Boolean(row.role === 'admin' && !row.x_totp && Number(row.x_has_password) && parseJson(row.x_require, false) === true),
  );
  for (const k of ['x_totp', 'x_has_password', 'x_created', 'x_seen', 'x_idle', 'x_require', 'x_tz']) delete row[k];
  return row;
}

/** What an admin who must first turn on two-factor may still call (Profile shows the setup; signing out is under /api/auth). */
function allowedBeforeTwoFactor(c) {
  const p = c.req.path;
  return (p === '/api/me' && c.req.method === 'GET') || p.startsWith('/api/me/2fa');
}

/** Middleware: requires a signed-in user; blocks cross-site writes. */
export function requireUser() {
  return async (c, next) => {
    // API tokens are sent explicitly (never by the browser on its own), so they need no CSRF header.
    if ((c.req.header('authorization') || '').startsWith('Bearer ')) {
      const user = await tokenUser(c);
      if (!user) fail(401, 'API token is not valid, expired, or its user is deactivated');
      c.set('user', user);
      c.set('authVia', 'token');
      c.set('tokenScope', user.projectScope);
      markDemo(c, user);
      return next();
    }
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.header('x-requested-with') !== 'opentrack') {
      fail(403, 'Missing X-Requested-With header');
    }
    const user = await currentUser(c);
    if (!user) fail(401, 'Not signed in');
    if (c.get('twoFactorSetupRequired') && !allowedBeforeTwoFactor(c)) {
      fail(403, 'This workspace requires two-factor sign-in for admins. Turn it on under Profile first.', { code: 'two_factor_required' });
    }
    c.set('user', user);
    c.set('authVia', 'session');
    markDemo(c, user);
    await next();
  };
}

/** The public demo account (lib/demo.js): flags the request and refuses the writes it may not make. */
function markDemo(c, user) {
  if (!isDemoUser(c.env, user)) return;
  c.set('demo', true);
  if (demoLocked(c)) fail(403, DEMO_READ_ONLY, { code: 'demo_read_only' });
}

export function requireAdmin(c) {
  if (c.get('user').role !== 'admin') fail(403, 'Admins only');
  if (c.get('authVia') === 'token') fail(403, 'Admin actions are only available in the web app, not with an API token');
  if (c.get('demo') && isWrite(c)) fail(403, DEMO_READ_ONLY, { code: 'demo_read_only' });
}

export function requireWriter(c) {
  if (c.get('user').role === 'viewer') fail(403, 'Viewers cannot make changes');
}

/** Guests (external clients) cannot use workspace-wide features: AI connectors, API tokens, creating projects. */
export function requireNotGuest(c, what = 'do this') {
  if (c.get('user').role === 'guest') fail(403, `Guests cannot ${what}`);
}
