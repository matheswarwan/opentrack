import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser, PASSWORD } from './helpers.js';
import { sha256, randomToken } from '../server/lib/crypto.js';

const O = 'http://t.example';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
let ctx, bob;

beforeEach(async () => {
  ctx = await withAdmin();
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  await bob.client.post('/api/projects', { key: 'WEB', name: 'Website' });
});

const req = (path, init = {}) => ctx.app.request(O + path, init, ctx.env);

/** Sign in like a browser and return the raw session cookie. */
async function cookieFor(email) {
  const res = await req('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'opentrack' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie').match(/it_session=[^;]+/)[0];
}

async function register(meta = {}) {
  const res = await req('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT], ...meta }),
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

async function pkce() {
  const verifier = randomToken(32);
  return { verifier, challenge: await sha256(verifier) };
}

function authorizeQuery(clientId, challenge, extra = {}) {
  return new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-1',
    resource: `${O}/mcp`,
    ...extra,
  }).toString();
}

/** GET the consent page, then POST the form the way the browser would. */
async function consent(cookie, clientId, challenge, decision = 'allow', extra = {}) {
  const q = authorizeQuery(clientId, challenge, extra);
  const page = await req(`/oauth/authorize?${q}`, { headers: { cookie } });
  expect(page.status).toBe(200);
  const html = await page.text();
  const fields = Object.fromEntries(
    [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [
      m[1],
      m[2].replace(/&amp;/g, '&').replace(/&quot;/g, '"'),
    ]),
  );
  const res = await req('/oauth/authorize', {
    method: 'POST',
    headers: { cookie, origin: O, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...fields, decision }).toString(),
  });
  return { page, html, res };
}

async function token(params, headers = {}) {
  const res = await req('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(params).toString(),
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

async function connect(email = 'bob@example.com') {
  const client = (await register()).body;
  const { verifier, challenge } = await pkce();
  const cookie = await cookieFor(email);
  const { res } = await consent(cookie, client.client_id, challenge);
  const code = new URL(res.headers.get('location')).searchParams.get('code');
  const t = await token({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: client.client_id,
    redirect_uri: REDIRECT,
  });
  return { client, verifier, code, cookie, tokens: t.body, tokenRes: t };
}

async function mcp(accessToken, body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_projects', arguments: {} } }) {
  const res = await req('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

describe('OAuth metadata', () => {
  it('serves protected resource and authorization server metadata with CORS', async () => {
    for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const res = await req(p);
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(await res.json()).toMatchObject({ resource: `${O}/mcp`, authorization_servers: [O], bearer_methods_supported: ['header'] });
    }
    const as = await (await req('/.well-known/oauth-authorization-server')).json();
    expect(as).toMatchObject({
      issuer: O,
      authorization_endpoint: `${O}/oauth/authorize`,
      token_endpoint: `${O}/oauth/token`,
      registration_endpoint: `${O}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
    });
    const pre = await req('/oauth/token', {
      method: 'OPTIONS',
      headers: { origin: 'https://claude.ai', 'access-control-request-method': 'POST' },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('uses PUBLIC_URL when set', async () => {
    ctx.env.PUBLIC_URL = 'https://tracker.example.com/';
    const pr = await (await req('/.well-known/oauth-protected-resource')).json();
    expect(pr.resource).toBe('https://tracker.example.com/mcp');
  });

  it('/mcp 401 points at the resource metadata', async () => {
    const r = await mcp(null);
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${O}/.well-known/oauth-protected-resource"`);
  });
});

describe('Dynamic client registration', () => {
  it('registers public and confidential clients', async () => {
    const pub = await register();
    expect(pub.status).toBe(201);
    expect(pub.body).toMatchObject({ client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' });
    expect(pub.body.client_secret).toBeUndefined();
    expect(pub.headers.get('access-control-allow-origin')).toBe('*');
    const conf = await register({ token_endpoint_auth_method: 'client_secret_post' });
    expect(conf.body.client_secret).toMatch(/.{20,}/);
  });

  it('refuses bad redirect URIs and metadata', async () => {
    expect((await register({ redirect_uris: ['http://evil.example/cb'] })).body.error).toBe('invalid_redirect_uri');
    expect((await register({ redirect_uris: [] })).status).toBe(400);
    expect((await register({ redirect_uris: ['https://a.example/cb#x'] })).status).toBe(400);
    expect((await register({ redirect_uris: ['http://localhost:3000/cb'] })).status).toBe(201);
    expect((await register({ redirect_uris: ['http://127.0.0.1/cb'] })).status).toBe(201);
    expect((await register({ client_name: 'x'.repeat(101) })).body.error).toBe('invalid_client_metadata');
    expect((await register({ token_endpoint_auth_method: 'private_key_jwt' })).body.error).toBe('invalid_client_metadata');
  });
});

describe('Authorization code flow', () => {
  it('sends a signed-out user to the login page with next', async () => {
    const client = (await register()).body;
    const { challenge } = await pkce();
    const q = authorizeQuery(client.client_id, challenge);
    const res = await req(`/oauth/authorize?${q}`);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location'), O);
    expect(loc.pathname).toBe('/login');
    expect(loc.searchParams.get('next')).toBe(`/oauth/authorize?${q}`);
  });

  it('shows consent, issues a code, exchanges it and calls /mcp', async () => {
    const client = (await register()).body;
    const { verifier, challenge } = await pkce();
    const cookie = await cookieFor('bob@example.com');
    const { page, html, res } = await consent(cookie, client.client_id, challenge);
    expect(html).toContain('Allow Claude to use Opentrack as Bob?');
    expect(page.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://claude.ai",
    );
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location'));
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get('state')).toBe('st-1');
    const code = loc.searchParams.get('code');
    expect(code).toBeTruthy();

    const t = await token({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      resource: `${O}/mcp`,
    });
    expect(t.status).toBe(200);
    expect(t.headers.get('cache-control')).toBe('no-store');
    expect(t.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
    expect(t.body.access_token).toMatch(/^otk_/);
    expect(t.body.refresh_token).toBeTruthy();

    const r = await mcp(t.body.access_token);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body.result.content[0].text)[0]).toMatchObject({ key: 'WEB' });
    // also works on the REST API, but not for token management
    const me = await req('/api/me', { headers: { authorization: `Bearer ${t.body.access_token}` } });
    expect((await me.json()).user.name).toBe('Bob');
    const mint = await req('/api/me/tokens', { headers: { authorization: `Bearer ${t.body.access_token}` } });
    expect(mint.status).toBe(403);
    // OAuth tokens are not listed as personal tokens
    expect((await bob.client.get('/api/me/tokens')).body.tokens).toEqual([]);
    const log = await ctx.db.all("SELECT * FROM audit_log WHERE action = 'oauth.authorized'");
    expect(log).toHaveLength(1);
  });

  it('rejects a wrong verifier, wrong redirect_uri and a reused code', async () => {
    const client = (await register()).body;
    const { verifier, challenge } = await pkce();
    const cookie = await cookieFor('bob@example.com');
    const getCode = async () =>
      new URL((await consent(cookie, client.client_id, challenge)).res.headers.get('location')).searchParams.get('code');
    const base = { grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: REDIRECT };

    const c1 = await getCode();
    const bad = await token({ ...base, code: c1, code_verifier: randomToken(32) });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_grant');

    const c2 = await getCode();
    expect((await token({ ...base, code: c2, code_verifier: verifier, redirect_uri: 'https://claude.ai/other' })).body.error).toBe(
      'invalid_grant',
    );

    const c3 = await getCode();
    const ok = await token({ ...base, code: c3, code_verifier: verifier });
    expect(ok.status).toBe(200);
    const again = await token({ ...base, code: c3, code_verifier: verifier });
    expect(again.body.error).toBe('invalid_grant');
    // reuse revokes what the code produced
    expect((await mcp(ok.body.access_token)).status).toBe(401);

    // another client cannot use the code
    const other = (await register()).body;
    const c4 = await getCode();
    expect((await token({ ...base, client_id: other.client_id, code: c4, code_verifier: verifier })).body.error).toBe('invalid_grant');
    expect((await token({ ...base, client_id: 'nope', code: c4, code_verifier: verifier })).status).toBe(401);
  });

  it('validates authorize requests', async () => {
    const client = (await register()).body;
    const { challenge } = await pkce();
    const cookie = await cookieFor('bob@example.com');
    const bad = await req(`/oauth/authorize?${authorizeQuery('unknown', challenge)}`, { headers: { cookie } });
    expect(bad.status).toBe(400);
    expect(bad.headers.get('content-type')).toContain('text/html');
    const wrongUri = await req(
      `/oauth/authorize?${authorizeQuery(client.client_id, challenge, { redirect_uri: 'https://evil.example/cb' })}`,
      { headers: { cookie } },
    );
    expect(wrongUri.status).toBe(400);
    expect(wrongUri.headers.get('location')).toBeNull();
    const noPkce = await req(`/oauth/authorize?${authorizeQuery(client.client_id, challenge, { code_challenge_method: 'plain' })}`, {
      headers: { cookie },
    });
    expect(noPkce.status).toBe(302);
    const loc = new URL(noPkce.headers.get('location'));
    expect(loc.searchParams.get('error')).toBe('invalid_request');
    expect(loc.searchParams.get('state')).toBe('st-1');
    const badResource = await req(
      `/oauth/authorize?${authorizeQuery(client.client_id, challenge, { resource: 'https://other.example/mcp' })}`,
      { headers: { cookie } },
    );
    expect(new URL(badResource.headers.get('location')).searchParams.get('error')).toBe('invalid_target');
  });

  it('refuses a consent POST without the session, from another origin or without the form token', async () => {
    const client = (await register()).body;
    const { challenge } = await pkce();
    const cookie = await cookieFor('bob@example.com');
    const q = Object.fromEntries(new URLSearchParams(authorizeQuery(client.client_id, challenge)));
    const post = (headers, extra = {}) =>
      req('/oauth/authorize', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams({ ...q, decision: 'allow', ...extra }).toString(),
      });
    expect((await post({ origin: O })).status).toBe(401);
    expect((await post({ cookie, origin: 'https://evil.example' })).status).toBe(403);
    expect((await post({ cookie, origin: O })).status).toBe(403); // no csrf field
    expect((await post({ cookie, origin: O }, { csrf: 'x' })).status).toBe(403);
    expect(await ctx.db.all('SELECT * FROM oauth_codes')).toHaveLength(0);
  });

  it('deny redirects with access_denied', async () => {
    const client = (await register()).body;
    const { challenge } = await pkce();
    const cookie = await cookieFor('bob@example.com');
    const { res } = await consent(cookie, client.client_id, challenge, 'deny');
    const loc = new URL(res.headers.get('location'));
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('state')).toBe('st-1');
    expect(loc.searchParams.get('code')).toBeNull();
  });

  it('confidential clients must send their secret (post body or Basic)', async () => {
    const client = (await register({ token_endpoint_auth_method: 'client_secret_basic' })).body;
    const { verifier, challenge } = await pkce();
    const cookie = await cookieFor('bob@example.com');
    const getCode = async () =>
      new URL((await consent(cookie, client.client_id, challenge)).res.headers.get('location')).searchParams.get('code');
    const base = { grant_type: 'authorization_code', redirect_uri: REDIRECT, code_verifier: verifier };
    expect((await token({ ...base, client_id: client.client_id, code: await getCode() })).status).toBe(401);
    const basic = `Basic ${btoa(`${client.client_id}:${client.client_secret}`)}`;
    expect((await token({ ...base, code: await getCode() }, { authorization: basic })).status).toBe(200);
    expect((await token({ ...base, client_id: client.client_id, client_secret: client.client_secret, code: await getCode() })).status).toBe(
      200,
    );
  });
});

describe('Refresh tokens', () => {
  it('rotates: the new pair works, the old refresh token does not', async () => {
    const { client, tokens } = await connect();
    const r1 = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(r1.status).toBe(200);
    expect(r1.body.refresh_token).not.toBe(tokens.refresh_token);
    expect((await mcp(r1.body.access_token)).status).toBe(200);
    const old = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(old.status).toBe(400);
    expect(old.body.error).toBe('invalid_grant');
    const other = (await register()).body;
    expect(
      (await token({ grant_type: 'refresh_token', refresh_token: r1.body.refresh_token, client_id: other.client_id })).body.error,
    ).toBe('invalid_grant');
    expect((await token({ grant_type: 'password', client_id: client.client_id })).body.error).toBe('unsupported_grant_type');
  });

  it('accepts JSON bodies', async () => {
    const { client, tokens } = await connect();
    const res = await req('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id }),
    });
    expect(res.status).toBe(200);
  });

  it('cleans up expired access tokens and codes', async () => {
    const { tokens, client } = await connect();
    await ctx.db.run("UPDATE api_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE kind = 'oauth'");
    expect((await mcp(tokens.access_token)).status).toBe(401);
    await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(await ctx.db.all("SELECT * FROM api_tokens WHERE expires_at < '2001-01-01'")).toHaveLength(0);
  });
});

describe('Deactivation and settings', () => {
  it('a deactivated user gets invalid_grant and their tokens stop working', async () => {
    const { client, tokens } = await connect();
    await ctx.admin.patch(`/api/admin/users/${bob.id}`, { status: 'deactivated' });
    expect((await mcp(tokens.access_token)).status).toBe(401);
    const r = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(r.body.error).toBe('invalid_grant');
  });

  it('a code for a user deactivated before the exchange is refused', async () => {
    const client = (await register()).body;
    const { verifier, challenge } = await pkce();
    const cookie = await cookieFor('bob@example.com');
    const code = new URL((await consent(cookie, client.client_id, challenge)).res.headers.get('location')).searchParams.get('code');
    await ctx.admin.patch(`/api/admin/users/${bob.id}`, { status: 'deactivated' });
    expect(
      (
        await token({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          client_id: client.client_id,
          redirect_uri: REDIRECT,
        })
      ).body.error,
    ).toBe('invalid_grant');
  });

  it('apiTokens = false refuses authorize, token and register', async () => {
    const { client, tokens, cookie } = await connect();
    await ctx.admin.patch('/api/admin/settings', { apiTokens: false });
    const { challenge } = await pkce();
    const page = await req(`/oauth/authorize?${authorizeQuery(client.client_id, challenge)}`, { headers: { cookie } });
    expect(page.status).toBe(403);
    expect(await page.text()).toContain('turned off');
    const r = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(r.status).toBe(400);
    expect(r.body.error_description).toContain('turned off');
    expect((await register()).status).toBe(403);
    expect((await mcp(tokens.access_token)).status).toBe(401);
  });
});

describe('Connected apps', () => {
  it('lists and revokes apps; personal token limit ignores OAuth tokens', async () => {
    const { client, tokens } = await connect();
    await mcp(tokens.access_token);
    const list = await bob.client.get('/api/me/connected-apps');
    expect(list.status).toBe(200);
    expect(list.body.apps).toHaveLength(1);
    expect(list.body.apps[0]).toMatchObject({ clientId: client.client_id, clientName: 'Claude' });
    expect(list.body.apps[0].authorizedAt).toBeTruthy();
    expect(list.body.apps[0].lastUsedAt).toBeTruthy();
    // other users don't see it
    expect((await ctx.admin.get('/api/me/connected-apps')).body.apps).toEqual([]);
    // an OAuth token cannot list or revoke apps
    const viaToken = await req('/api/me/connected-apps', { headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(viaToken.status).toBe(403);

    // OAuth tokens don't count toward the 10 personal tokens
    for (let i = 0; i < 10; i++) expect((await bob.client.post('/api/me/tokens', { name: `t${i}` })).status).toBe(201);
    expect((await bob.client.post('/api/me/tokens', { name: 'eleven' })).status).toBe(400);
    expect((await bob.client.get('/api/me/tokens')).body.tokens).toHaveLength(10);

    expect((await ctx.admin.del(`/api/me/connected-apps/${client.client_id}`)).status).toBe(404);
    const del = await bob.client.del(`/api/me/connected-apps/${client.client_id}`);
    expect(del.status).toBe(200);
    expect((await mcp(tokens.access_token)).status).toBe(401);
    expect(
      (await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id })).body.error,
    ).toBe('invalid_grant');
    expect((await bob.client.get('/api/me/connected-apps')).body.apps).toEqual([]);
    expect(await ctx.db.all("SELECT * FROM audit_log WHERE action = 'oauth.revoked'")).toHaveLength(1);
  });

  it('revocation endpoint drops a refresh token', async () => {
    const { client, tokens } = await connect();
    const res = await req('/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: tokens.refresh_token, client_id: client.client_id }).toString(),
    });
    expect(res.status).toBe(200);
    expect(
      (await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id })).body.error,
    ).toBe('invalid_grant');
  });
});
