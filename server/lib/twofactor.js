// Two-factor sign-in: TOTP (RFC 6238, the 6-digit codes of authenticator apps) and one-time recovery codes.
// Web Crypto only, so it runs the same on Cloudflare Workers and Node.
//
// Storage (migration 0033): users.totp_secret (base32; pending until users.totp_enabled_at is set),
// users.totp_last_step (the last accepted time step: a code works once), recovery_codes (hashes only) and
// login_challenges (the second sign-in step). The secret is stored as is: this code base has no server-side
// encryption key. None of it is ever written to a backup (lib/backup.js NEVER).
import { sha256, uuid, now, randomToken } from './crypto.js';
import { clock } from './time.js';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const RECOVERY_CODES = 10;
export const CHALLENGE_MINUTES = 5;
/** Failed passwords and failed codes share this limit (login_failures, per email). */
export const MAX_FAILURES = 10;
export const FAILURE_WINDOW_MS = 15 * 60e3;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const clean = String(text)
    .toUpperCase()
    .replace(/[\s=-]/g, '');
  const out = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Not base32');
    value = ((value << 5) | i) & 0xfff; // only the low bits are still needed
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** HOTP (RFC 4226) for a counter. `algorithm` is SHA-1 for authenticator apps; the RFC 6238 vectors also use SHA-256 and SHA-512. */
export async function hotp(keyBytes, counter, { digits = TOTP_DIGITS, algorithm = 'SHA-1' } = {}) {
  const msg = new Uint8Array(8);
  let n = Math.floor(counter);
  for (let i = 7; i >= 0; i--) {
    msg[i] = n % 256;
    n = Math.floor(n / 256);
  }
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: algorithm }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const o = mac[mac.length - 1] & 15;
  const bin = (mac[o] & 127) * 2 ** 24 + (mac[o + 1] << 16) + (mac[o + 2] << 8) + mac[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const timeStep = (ms = Date.now()) => Math.floor(ms / 1000 / TOTP_STEP_SECONDS);

/** The code an authenticator app shows for this base32 secret at `ms`. */
export function totp(secret, ms = Date.now()) {
  return hotp(base32Decode(secret), timeStep(ms));
}

/**
 * The time step a code matches (this step, or one step either side for clock drift), or null.
 * `after`: steps up to this one were used already and never match again.
 */
export async function matchingStep(secret, code, ms = Date.now(), after = null) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  let key;
  try {
    key = base32Decode(secret);
  } catch {
    return null;
  }
  const cur = timeStep(ms);
  let found = null;
  for (const step of [cur - 1, cur, cur + 1]) {
    // every candidate is computed, so timing does not show which step matched
    const ok = (await hotp(key, step)) === c;
    if (ok && found === null && (after === null || after === undefined || step > Number(after))) found = step;
  }
  return found;
}

export function newSecret() {
  const b = new Uint8Array(20);
  crypto.getRandomValues(b);
  return base32Encode(b);
}

/** otpauth:// URI for the QR code (Key Uri Format). */
export function otpauthUri(appName, email, secret) {
  const issuer = String(appName || 'Tracker')
    .replace(/:/g, ' ')
    .slice(0, 40);
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

const RC = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o, 1/l/i
function recoveryCode() {
  const b = new Uint8Array(10);
  let s = '';
  // rejection sampling keeps every character equally likely
  while (s.length < 10) {
    crypto.getRandomValues(b);
    for (const x of b) if (x < 248 && s.length < 10) s += RC[x % 31];
  }
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}
const normalizeRecovery = (code) =>
  String(code || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
const recoveryHash = (userId, code) => sha256(`recovery:${userId}:${normalizeRecovery(code)}`);

/** Fresh recovery codes: the plain codes (shown once) and the statements that replace the stored hashes. */
export async function newRecoveryCodes(userId) {
  const codes = Array.from({ length: RECOVERY_CODES }, recoveryCode);
  const stmts = [{ sql: 'DELETE FROM recovery_codes WHERE user_id = ?', params: [userId] }];
  for (const code of codes) {
    stmts.push({
      sql: 'INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, ?)',
      params: [uuid(), userId, await recoveryHash(userId, code), now()],
    });
  }
  return { codes, stmts };
}

export async function recoveryCodesLeft(db, userId) {
  const r = await db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL', [userId]);
  return Number(r?.n) || 0;
}

/**
 * Check a second factor for a person with two-factor on: a 6-digit code, or a recovery code.
 * A code works once (the accepted time step is stored); a recovery code works once.
 * Returns 'totp', 'recovery' or null. `user` needs id and totp_secret.
 */
export async function checkSecondFactor(db, env, user, code) {
  const text = String(code || '').trim();
  if (!text || text.length > 40 || !user?.totp_secret) return null;
  if (/^\d{6}$/.test(text.replace(/\s/g, ''))) {
    const fresh = await db.get('SELECT totp_last_step FROM users WHERE id = ?', [user.id]);
    const step = await matchingStep(user.totp_secret, text, clock(env), fresh?.totp_last_step);
    if (step === null) return null;
    // the condition makes two requests with the same code race safely: only one changes the row
    const r = await db.run('UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)', [
      step,
      user.id,
      step,
    ]);
    return r.changes ? 'totp' : null;
  }
  if (normalizeRecovery(text).length !== 10) return null;
  const r = await db.run('UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL', [
    now(),
    user.id,
    await recoveryHash(user.id, text),
  ]);
  return r.changes ? 'recovery' : null;
}

// ---- failed attempts (shared with password sign-in: server/routes/auth.js) ----
export async function tooManyFailures(db, email) {
  const since = new Date(Date.now() - FAILURE_WINDOW_MS).toISOString();
  const r = await db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM login_failures WHERE email = ? AND created_at > ?', [email, since]);
  return Number(r?.n) >= MAX_FAILURES;
}

export function recordFailure(db, email) {
  return db.batch([
    { sql: 'INSERT INTO login_failures (id, email, created_at) VALUES (?, ?, ?)', params: [uuid(), email, now()] },
    { sql: 'DELETE FROM login_failures WHERE created_at < ?', params: [new Date(Date.now() - 864e5).toISOString()] },
  ]);
}

// ---- the second sign-in step ----
/** After a correct password: a token (5 minutes) the browser sends back with the code. No session exists yet. */
export async function startChallenge(db, userId) {
  const token = randomToken();
  await db.batch([
    { sql: 'DELETE FROM login_challenges WHERE expires_at < ?', params: [now()] },
    {
      sql: 'INSERT INTO login_challenges (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      params: [await sha256(token), userId, now(), new Date(Date.now() + CHALLENGE_MINUTES * 60e3).toISOString()],
    },
  ]);
  return token;
}

/** The person a pending token belongs to (with their secret), or null when it is unknown or expired. */
export async function challengeUser(db, token) {
  if (typeof token !== 'string' || !token || token.length > 200) return null;
  return db.get(
    `SELECT u.id, u.email, u.totp_secret, u.totp_enabled_at FROM login_challenges ch JOIN users u ON u.id = ch.user_id
      WHERE ch.id = ? AND ch.expires_at > ? AND u.status = 'active' AND u.is_system = 0 AND u.totp_enabled_at IS NOT NULL`,
    [await sha256(token), now()],
  );
}

/** Statements that turn two-factor off for a person (their recovery codes and pending sign-ins go too). */
export function clearTwoFactor(userId) {
  return [
    {
      sql: 'UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL, updated_at = ? WHERE id = ?',
      params: [now(), userId],
    },
    { sql: 'DELETE FROM recovery_codes WHERE user_id = ?', params: [userId] },
    { sql: 'DELETE FROM login_challenges WHERE user_id = ?', params: [userId] },
  ];
}

/** "Chrome on macOS" from a user agent, kept simple. */
export function describeAgent(ua) {
  const s = String(ua || '');
  if (!s) return 'Unknown browser';
  const browser = /Edg(e|A|iOS)?\//.test(s)
    ? 'Edge'
    : /OPR\/|Opera/.test(s)
      ? 'Opera'
      : /Firefox\/|FxiOS\//.test(s)
        ? 'Firefox'
        : /Chrome\/|CriOS\//.test(s)
          ? 'Chrome'
          : /Safari\//.test(s)
            ? 'Safari'
            : /curl\//i.test(s)
              ? 'curl'
              : 'Unknown browser';
  const os = /iPhone|iPod/.test(s)
    ? 'iPhone'
    : /iPad/.test(s)
      ? 'iPad'
      : /Android/.test(s)
        ? 'Android'
        : /CrOS/.test(s)
          ? 'ChromeOS'
          : /Windows/.test(s)
            ? 'Windows'
            : /Mac OS X|Macintosh/.test(s)
              ? 'macOS'
              : /Linux/.test(s)
                ? 'Linux'
                : '';
  return os ? `${browser} on ${os}` : browser;
}
