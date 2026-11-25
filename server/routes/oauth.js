// OAuth 2.1 authorization server for the MCP server (MCP authorization spec 2025-06-18):
// protected resource metadata (RFC 9728), authorization server metadata (RFC 8414),
// dynamic client registration (RFC 7591), authorization code + PKCE S256, refresh tokens,
// revocation (RFC 7009). Access tokens are api_tokens rows (kind 'oauth'), so tokenUser()
// and every permission check treat them like personal API tokens.
import { getCookie } from 'hono/cookie';
import { uuid, now, sha256, randomToken, safeEqual } from '../lib/crypto.js';
import { currentUser, newApiToken, SESSION_COOKIE } from '../lib/session.js';
import { audit } from '../lib/audit.js';
import { getSettings } from '../lib/settings.js';
import { publicOrigin } from '../lib/http.js';
import { parseList } from '../lib/json.js';

const ACCESS_SECONDS = 3600;
const REFRESH_DAYS = 30;
const CODE_SECONDS = 600;
const MAX_CLIENTS = 1000;
const SCOPE = 'mcp';
const REFRESH_PREFIX = 'atr_';
const DISABLED = 'An admin has turned off API tokens and AI assistant connections for this tracker.';

const iso = (ms) => new Date(Date.now() + ms).toISOString();

function cors(c) {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'authorization, content-type, mcp-protocol-version');
  c.header('Access-Control-Max-Age', '86400');
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

function oauthError(c, status, error, description) {
  c.header('Cache-Control', 'no-store');
  return c.json({ error, ...(description ? { error_description: description } : {}) }, status);
}

/** Allowed redirect URI: https, or http on a loopback host. No fragment. */
export function validRedirectUri(u) {
  if (typeof u !== 'string' || !u || u.length > 2000) return false;
  let url;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.hash || u.includes('#')) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

const PKCE_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

async function getClient(db, clientId) {
  if (typeof clientId !== 'string' || !clientId || clientId.length > 100) return null;
  const row = await db.get('SELECT * FROM oauth_clients WHERE client_id = ?', [clientId]);
  if (!row) return null;
  return { ...row, redirectUris: parseList(row.redirect_uris) };
}

/** Page shown when the request can't safely go back to the client. */
function errorPage(c, status, message) {
  c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  c.header('Cache-Control', 'no-store');
  return c.html(
    page('Cannot connect', `<h1>Cannot connect this app</h1><p>${esc(message)}</p><p><a href="/">Go to the tracker</a></p>`),
    status,
  );
}

function page(title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>
body{margin:0;background:#f1f5f9;color:#0f172a;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:440px;margin:10vh auto;background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:24px 28px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
h1{font-size:18px;margin:0 0 12px}ul{padding-left:20px;margin:8px 0 16px}li{margin:4px 0}
.muted{color:#64748b;font-size:13px}.row{display:flex;gap:8px;justify-content:flex-end;margin-top:20px}
button{font:inherit;padding:8px 16px;border-radius:6px;border:1px solid #cbd5e1;background:#fff;cursor:pointer}
button.primary{background:#0f766e;border-color:#0f766e;color:#fff}a{color:#0f766e}code{font-size:13px}
@media (prefers-color-scheme:dark){body{background:#0f172a;color:#e2e8f0}main{background:#1e293b;border-color:#334155}.muted{color:#94a3b8}button{background:#334155;color:#e2e8f0;border-color:#475569}a{color:#5eead4}}
</style></head><body><main>${inner}</main></body></html>`;
}

function redirectWith(c, redirectUri, params) {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  c.header('Cache-Control', 'no-store');
  return c.redirect(url.toString(), 302);
}

/**
 * Validate an authorization request. Returns { fatal } (show an error page), { redirectError }
 * (send the error back to the client) or { client, params } when it is fine.
 */
async function checkAuthorize(c, q) {
  const db = c.env.db;
  if (!(await getSettings(db)).apiTokens) return { fatal: [403, DISABLED] };
  const client = await getClient(db, q.client_id);
  if (!client)
    return { fatal: [400, 'This app is not registered with the tracker (unknown client_id). Remove the connector and add it again.'] };
  let redirectUri = q.redirect_uri;
  if (!redirectUri && client.redirectUris.length === 1) redirectUri = client.redirectUris[0];
  if (!redirectUri || !client.redirectUris.includes(redirectUri))
    return { fatal: [400, 'The redirect address does not match the one this app registered.'] };
  const state = typeof q.state === 'string' ? q.state.slice(0, 500) : undefined;
  const bad = (error, error_description) => ({ redirectError: { redirectUri, params: { error, error_description, state } } });
  if (q.response_type !== 'code') return bad('unsupported_response_type', 'Only response_type=code is supported');
  if (!q.code_challenge || !CHALLENGE_RE.test(q.code_challenge)) return bad('invalid_request', 'PKCE code_challenge is required');
  if (q.code_challenge_method !== 'S256') return bad('invalid_request', 'code_challenge_method must be S256');
  const origin = publicOrigin(c);
  const resource = q.resource || null;
  if (resource && ![`${origin}/mcp`, origin, `${origin}/`].includes(resource)) return bad('invalid_target', 'Unknown resource');
  return {
    client,
    params: {
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: 'code',
      code_challenge: q.code_challenge,
      code_challenge_method: 'S256',
      state,
      resource,
      scope: q.scope,
    },
  };
}

async function consentCsrf(c) {
  return sha256(`oauth-consent:${getCookie(c, SESSION_COOKIE) || ''}`);
}

/** Client authentication at the token and revocation endpoints. Returns the client or null. */
async function authClient(c, b) {
  let id = b.client_id;
  let secret = b.client_secret;
  const auth = c.req.header('authorization') || '';
  if (auth.startsWith('Basic ')) {
    try {
      const [u, p] = atob(auth.slice(6).trim()).split(':');
      id = decodeURIComponent(u);
      secret = decodeURIComponent(p ?? '');
    } catch {
      return null;
    }
  }
  const client = await getClient(c.env.db, id);
  if (!client) return null;
  if (client.client_secret_hash) {
    if (typeof secret !== 'string' || !safeEqual(await sha256(secret), client.client_secret_hash)) return null;
  }
  return client;
}

async function readForm(c) {
  const type = c.req.header('content-type') || '';
  try {
    if (type.includes('application/json')) {
      const j = await c.req.json();
      return j && typeof j === 'object' ? j : {};
    }
    const text = await c.req.text();
    return Object.fromEntries(new URLSearchParams(text));
  } catch {
    return {};
  }
}

/** New access token (api_tokens row) and rotated refresh token for a user and client. */
async function issueTokens(db, client, userId, grantedAt, extra = []) {
  const access = newApiToken();
  const refresh = REFRESH_PREFIX + randomToken(32);
  const t = now();
  await db.batch([
    ...extra,
    {
      sql: 'INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, created_at, expires_at, kind, client_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      params: [
        uuid(),
        userId,
        (client.client_name || 'OAuth app').slice(0, 100),
        await sha256(access),
        access.slice(0, 8),
        t,
        iso(ACCESS_SECONDS * 1000),
        'oauth',
        client.client_id,
      ],
    },
    {
      sql: 'INSERT INTO oauth_refresh_tokens (token_hash, client_id, user_id, expires_at, created_at, granted_at) VALUES (?, ?, ?, ?, ?, ?)',
      params: [await sha256(refresh), client.client_id, userId, iso(REFRESH_DAYS * 864e5), t, grantedAt],
    },
  ]);
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_SECONDS, refresh_token: refresh, scope: SCOPE };
}

export function registerOAuth(app) {
  for (const p of ['/.well-known/*', '/oauth/register', '/oauth/token', '/oauth/revoke']) {
    app.use(p, async (c, next) => {
      cors(c);
      if (c.req.method === 'OPTIONS') return c.body(null, 204);
      await next();
      cors(c);
    });
  }

  const resourceMeta = (c) => {
    const origin = publicOrigin(c);
    return c.json({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ['header'],
      scopes_supported: [SCOPE],
      resource_name: 'Opentrack',
    });
  };
  app.get('/.well-known/oauth-protected-resource', resourceMeta);
  app.get('/.well-known/oauth-protected-resource/mcp', resourceMeta);

  const asMeta = (c) => {
    const origin = publicOrigin(c);
    return c.json({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      revocation_endpoint: `${origin}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: [SCOPE],
    });
  };
  app.get('/.well-known/oauth-authorization-server', asMeta);
  app.get('/.well-known/oauth-authorization-server/mcp', asMeta);

  // ---- Dynamic client registration (RFC 7591) ----
  app.post('/oauth/register', async (c) => {
    const db = c.env.db;
    if (!(await getSettings(db)).apiTokens) return oauthError(c, 403, 'access_denied', DISABLED);
    let b;
    try {
      b = await c.req.json();
    } catch {
      return oauthError(c, 400, 'invalid_client_metadata', 'Send the client metadata as JSON');
    }
    if (!b || typeof b !== 'object') return oauthError(c, 400, 'invalid_client_metadata', 'Send the client metadata as JSON');
    const uris = b.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10)
      return oauthError(c, 400, 'invalid_redirect_uri', 'redirect_uris must list 1 to 10 addresses');
    if (!uris.every(validRedirectUri))
      return oauthError(
        c,
        400,
        'invalid_redirect_uri',
        'Redirect addresses must use https (http only for localhost or 127.0.0.1) and have no fragment',
      );
    if (b.client_name !== undefined && (typeof b.client_name !== 'string' || b.client_name.length > 100)) {
      return oauthError(c, 400, 'invalid_client_metadata', 'client_name must be text of at most 100 characters');
    }
    const method = b.token_endpoint_auth_method ?? 'none';
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method))
      return oauthError(c, 400, 'invalid_client_metadata', 'Unsupported token_endpoint_auth_method');
    const grants = b.grant_types ?? ['authorization_code', 'refresh_token'];
    if (!Array.isArray(grants) || !grants.every((g) => ['authorization_code', 'refresh_token'].includes(g)))
      return oauthError(c, 400, 'invalid_client_metadata', 'Unsupported grant_types');
    const responses = b.response_types ?? ['code'];
    if (!Array.isArray(responses) || !responses.every((r) => r === 'code'))
      return oauthError(c, 400, 'invalid_client_metadata', 'Unsupported response_types');

    // Cap the number of registered clients. When full, drop week-old clients nobody authorised.
    const count = async () => (await db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM oauth_clients')).n;
    if ((await count()) >= MAX_CLIENTS) {
      await db.run(
        `DELETE FROM oauth_clients WHERE created_at < ?
           AND client_id NOT IN (SELECT client_id FROM oauth_refresh_tokens)
           AND client_id NOT IN (SELECT client_id FROM oauth_codes)
           AND client_id NOT IN (SELECT client_id FROM api_tokens WHERE client_id IS NOT NULL)`,
        [iso(-7 * 864e5)],
      );
      if ((await count()) >= MAX_CLIENTS)
        return oauthError(c, 503, 'temporarily_unavailable', 'Too many registered apps. Try again later.');
    }

    const clientId = uuid();
    const secret = method === 'none' ? null : randomToken(32);
    const name = (b.client_name || '').trim() || null;
    const created = now();
    await db.run(
      'INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?, ?)',
      [clientId, secret ? await sha256(secret) : null, name, JSON.stringify(uris), created],
    );
    c.header('Cache-Control', 'no-store');
    return c.json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.parse(created) / 1000),
        ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
        ...(name ? { client_name: name } : {}),
        redirect_uris: uris,
        grant_types: grants,
        response_types: ['code'],
        token_endpoint_auth_method: method,
      },
      201,
    );
  });

  // ---- Authorization endpoint ----
  app.get('/oauth/authorize', async (c) => {
    const q = c.req.query();
    const r = await checkAuthorize(c, q);
    if (r.fatal) return errorPage(c, ...r.fatal);
    if (r.redirectError) return redirectWith(c, r.redirectError.redirectUri, r.redirectError.params);
    const user = await currentUser(c);
    if (!user) {
      const u = new URL(c.req.url);
      return c.redirect(`/login?next=${encodeURIComponent(u.pathname + u.search)}`, 302);
    }
    if (user.role === 'guest') return errorPage(c, 403, 'Guest accounts cannot connect AI apps to the tracker.');
    if (c.get('twoFactorSetupRequired'))
      return errorPage(
        c,
        403,
        'This workspace requires two-factor sign-in for admins. Turn it on under Profile in the tracker, then connect again.',
      );
    const { client, params } = r;
    const appName = client.client_name || 'An unnamed app';
    const back = new URL(params.redirect_uri);
    const hidden = Object.entries({ ...params, csrf: await consentCsrf(c) })
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
      .join('');
    c.header('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${back.origin}`);
    c.header('Cache-Control', 'no-store');
    return c.html(
      page(
        'Connect an app',
        `<h1>Allow ${esc(appName)} to use Opentrack as ${esc(user.name)}?</h1>
<p>If you allow it, ${esc(appName)} can:</p>
<ul><li>Read the projects and issues you can access</li><li>Create and change issues, comments and work logs, as you</li></ul>
<p class="muted">It cannot change admin settings or create API tokens. Signed in as ${esc(user.email)}. After you choose, you go back to <code>${esc(back.host)}</code>. The app name is given by the app itself, so only allow apps you set up. You can remove access any time under AI connectors &gt; Connected apps.</p>
<form method="post" action="/oauth/authorize">${hidden}
<div class="row"><button type="submit" name="decision" value="deny">Deny</button><button type="submit" name="decision" value="allow" class="primary">Allow</button></div>
</form>`,
      ),
    );
  });

  app.post('/oauth/authorize', async (c) => {
    const reqOrigin = c.req.header('origin');
    if (reqOrigin && reqOrigin !== publicOrigin(c) && reqOrigin !== new URL(c.req.url).origin)
      return errorPage(c, 403, 'This request did not come from the tracker.');
    const user = await currentUser(c);
    if (!user) return errorPage(c, 401, 'You are not signed in to the tracker. Sign in and try connecting again.');
    if (user.role === 'guest') return errorPage(c, 403, 'Guest accounts cannot connect AI apps to the tracker.');
    if (c.get('twoFactorSetupRequired'))
      return errorPage(
        c,
        403,
        'This workspace requires two-factor sign-in for admins. Turn it on under Profile in the tracker, then connect again.',
      );
    const b = await readForm(c);
    if (typeof b.csrf !== 'string' || !safeEqual(b.csrf, await consentCsrf(c)))
      return errorPage(c, 403, 'This request did not come from the tracker.');
    const r = await checkAuthorize(c, b);
    if (r.fatal) return errorPage(c, ...r.fatal);
    if (r.redirectError) return redirectWith(c, r.redirectError.redirectUri, r.redirectError.params);
    const { client, params } = r;
    if (b.decision !== 'allow')
      return redirectWith(c, params.redirect_uri, {
        error: 'access_denied',
        error_description: 'The user denied access',
        state: params.state,
      });
    const code = randomToken(32);
    await c.env.db.batch([
      {
        sql: 'INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        params: [
          await sha256(code),
          client.client_id,
          user.id,
          params.redirect_uri,
          params.code_challenge,
          params.resource,
          iso(CODE_SECONDS * 1000),
        ],
      },
      audit(user.id, 'oauth.authorized', 'oauth_client', client.client_id, {
        clientName: client.client_name,
        redirectUri: params.redirect_uri,
      }),
    ]);
    return redirectWith(c, params.redirect_uri, { code, state: params.state, iss: publicOrigin(c) });
  });

  // ---- Token endpoint ----
  app.post('/oauth/token', async (c) => {
    const db = c.env.db;
    const t = now();
    await db.batch([
      { sql: "DELETE FROM api_tokens WHERE kind = 'oauth' AND expires_at < ?", params: [t] },
      { sql: 'DELETE FROM oauth_refresh_tokens WHERE expires_at < ?', params: [t] },
      { sql: 'DELETE FROM oauth_codes WHERE expires_at < ?', params: [t] },
    ]);
    const b = await readForm(c);
    const client = await authClient(c, b);
    if (!client) {
      c.header('WWW-Authenticate', 'Basic realm="opentrack"');
      return oauthError(c, 401, 'invalid_client', 'Unknown client or wrong client secret');
    }
    if (!(await getSettings(db)).apiTokens) return oauthError(c, 400, 'unauthorized_client', DISABLED);
    const activeUser = async (id) => db.get("SELECT id FROM users WHERE id = ? AND status = 'active'", [id]);

    if (b.grant_type === 'authorization_code') {
      if (typeof b.code !== 'string' || !b.code) return oauthError(c, 400, 'invalid_request', 'code is required');
      const hash = await sha256(b.code);
      const row = await db.get('SELECT * FROM oauth_codes WHERE code_hash = ?', [hash]);
      if (!row || row.client_id !== client.client_id || row.expires_at < t)
        return oauthError(c, 400, 'invalid_grant', 'The code is not valid or has expired');
      if (row.used_at) {
        // A reused code may mean it was stolen: drop what it produced (OAuth 2.1 section 4.1.2).
        await db.batch([
          {
            sql: "DELETE FROM api_tokens WHERE kind = 'oauth' AND user_id = ? AND client_id = ? AND created_at >= ?",
            params: [row.user_id, row.client_id, row.used_at],
          },
          {
            sql: 'DELETE FROM oauth_refresh_tokens WHERE user_id = ? AND client_id = ? AND granted_at = ?',
            params: [row.user_id, row.client_id, row.used_at],
          },
        ]);
        return oauthError(c, 400, 'invalid_grant', 'The code was already used');
      }
      if (b.redirect_uri !== undefined ? b.redirect_uri !== row.redirect_uri : false)
        return oauthError(c, 400, 'invalid_grant', 'redirect_uri does not match');
      if (
        typeof b.code_verifier !== 'string' ||
        !PKCE_RE.test(b.code_verifier) ||
        !safeEqual(await sha256(b.code_verifier), row.code_challenge)
      ) {
        return oauthError(c, 400, 'invalid_grant', 'PKCE code_verifier does not match');
      }
      if (b.resource && row.resource && b.resource !== row.resource)
        return oauthError(c, 400, 'invalid_target', 'resource does not match the authorization request');
      // Mark used first; only one request can win.
      const mark = await db.run('UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL', [t, hash]);
      if (!mark.changes) return oauthError(c, 400, 'invalid_grant', 'The code was already used');
      if (!(await activeUser(row.user_id))) return oauthError(c, 400, 'invalid_grant', 'This user is deactivated');
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(await issueTokens(db, client, row.user_id, t));
    }

    if (b.grant_type === 'refresh_token') {
      if (typeof b.refresh_token !== 'string' || !b.refresh_token)
        return oauthError(c, 400, 'invalid_request', 'refresh_token is required');
      const hash = await sha256(b.refresh_token);
      const row = await db.get('SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?', [hash]);
      if (!row || row.client_id !== client.client_id || row.expires_at < t)
        return oauthError(c, 400, 'invalid_grant', 'The refresh token is not valid or has expired');
      const del = await db.run('DELETE FROM oauth_refresh_tokens WHERE token_hash = ?', [hash]);
      if (!del.changes) return oauthError(c, 400, 'invalid_grant', 'The refresh token was already used');
      if (!(await activeUser(row.user_id))) return oauthError(c, 400, 'invalid_grant', 'This user is deactivated');
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(await issueTokens(db, client, row.user_id, row.granted_at));
    }

    return oauthError(c, 400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
  });

  // ---- Revocation (RFC 7009): always 200 ----
  app.post('/oauth/revoke', async (c) => {
    const db = c.env.db;
    const b = await readForm(c);
    const client = await authClient(c, b);
    if (!client) return oauthError(c, 401, 'invalid_client', 'Unknown client or wrong client secret');
    if (typeof b.token === 'string' && b.token) {
      const hash = await sha256(b.token);
      await db.batch([
        { sql: "DELETE FROM api_tokens WHERE token_hash = ? AND kind = 'oauth' AND client_id = ?", params: [hash, client.client_id] },
        { sql: 'DELETE FROM oauth_refresh_tokens WHERE token_hash = ? AND client_id = ?', params: [hash, client.client_id] },
      ]);
    }
    c.header('Cache-Control', 'no-store');
    return c.body(null, 200);
  });
}
