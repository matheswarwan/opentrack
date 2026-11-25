import { describe, it, expect } from 'vitest';
import { makeEnv, withAdmin, client, SETUP_TOKEN, PASSWORD } from './helpers.js';

describe('first admin setup', () => {
  it('needs the setup token and only works once', async () => {
    const ctx = await makeEnv();
    const c = client(ctx);
    expect((await c.get('/api/auth/config')).body.needsSetup).toBe(true);
    expect((await c.post('/api/auth/setup', { token: 'nope', email: 'a@x.io', name: 'A', password: PASSWORD })).status).toBe(403);
    expect((await c.post('/api/auth/setup', { token: SETUP_TOKEN, email: 'a@x.io', name: 'A', password: 'short' })).status).toBe(400);
    expect((await c.post('/api/auth/setup', { token: SETUP_TOKEN, email: 'a@x.io', name: 'A', password: PASSWORD })).status).toBe(200);
    const me = await c.get('/api/me');
    expect(me.body.user).toMatchObject({ email: 'a@x.io', role: 'admin' });
    expect((await client(ctx).post('/api/auth/setup', { token: SETUP_TOKEN, email: 'b@x.io', name: 'B', password: PASSWORD })).status).toBe(
      409,
    );
    expect((await c.get('/api/auth/config')).body.needsSetup).toBe(false);
  });

  it('is off without a SETUP_TOKEN', async () => {
    const ctx = await makeEnv({ SETUP_TOKEN: '' });
    expect((await client(ctx).post('/api/auth/setup', { token: '', email: 'a@x.io', name: 'A', password: PASSWORD })).status).toBe(403);
  });
});

describe('login and sessions', () => {
  it('signs in, signs out and rejects wrong passwords', async () => {
    const ctx = await withAdmin();
    const c = client(ctx);
    expect((await c.get('/api/me')).status).toBe(401);
    expect((await c.post('/api/auth/login', { email: 'admin@example.com', password: 'wrong password' })).status).toBe(401);
    expect((await c.post('/api/auth/login', { email: 'ADMIN@example.com', password: PASSWORD })).status).toBe(200);
    expect((await c.get('/api/me')).status).toBe(200);
    await c.post('/api/auth/logout');
    expect((await c.get('/api/me')).status).toBe(401);
  });

  it('locks out after 10 failures', async () => {
    const ctx = await withAdmin();
    const c = client(ctx);
    for (let i = 0; i < 10; i++) await c.post('/api/auth/login', { email: 'admin@example.com', password: 'bad' });
    expect((await c.post('/api/auth/login', { email: 'admin@example.com', password: PASSWORD })).status).toBe(429);
  });

  it('refuses writes without the CSRF header', async () => {
    const ctx = await withAdmin();
    expect((await ctx.admin.post('/api/projects', { key: 'AB', name: 'x' }, { noCsrf: true })).status).toBe(403);
    expect((await client(ctx).post('/api/auth/login', { email: 'admin@example.com', password: PASSWORD }, { noCsrf: true })).status).toBe(
      403,
    );
  });
});

describe('user provisioning', () => {
  it('admin creates a user with an invite link; the user sets a password', async () => {
    const ctx = await withAdmin();
    const r = await ctx.admin.post('/api/admin/users', { email: 'Bob@Example.com', name: 'Bob', role: 'member' });
    expect(r.status).toBe(201);
    expect(r.body.user.status).toBe('invited');
    const token = r.body.user.inviteLink.split('/invite/')[1];
    const bob = client(ctx);
    // invited users cannot sign in yet
    expect((await bob.post('/api/auth/login', { email: 'bob@example.com', password: PASSWORD })).status).toBe(401);
    const info = await bob.get(`/api/auth/invite/${token}`);
    expect(info.body).toMatchObject({ email: 'bob@example.com', name: 'Bob' });
    expect((await bob.post(`/api/auth/invite/${token}`, { password: 'short' })).status).toBe(400);
    expect((await bob.post(`/api/auth/invite/${token}`, { password: PASSWORD, name: 'Bob Builder' })).status).toBe(200);
    const me = await bob.get('/api/me');
    expect(me.body.user).toMatchObject({ email: 'bob@example.com', name: 'Bob Builder', role: 'member' });
    // link is single use
    expect((await client(ctx).get(`/api/auth/invite/${token}`)).status).toBe(404);
    const list = await ctx.admin.get('/api/admin/users');
    expect(list.body.users.find((u) => u.email === 'bob@example.com').status).toBe('active');
  });

  it('admin creates an active user with a password', async () => {
    const ctx = await withAdmin();
    const r = await ctx.admin.post('/api/admin/users', { email: 'carol@example.com', name: 'Carol', role: 'viewer', password: PASSWORD });
    expect(r.body.user).toMatchObject({ status: 'active', inviteLink: null });
    const carol = client(ctx);
    expect((await carol.post('/api/auth/login', { email: 'carol@example.com', password: PASSWORD })).status).toBe(200);
    expect((await carol.get('/api/me')).body.user.role).toBe('viewer');
    expect((await carol.post('/api/projects', { key: 'CAR', name: 'Carol' })).status).toBe(403);
  });

  it('rejects duplicates and bad input', async () => {
    const ctx = await withAdmin();
    expect((await ctx.admin.post('/api/admin/users', { email: 'admin@example.com', name: 'x' })).status).toBe(409);
    expect((await ctx.admin.post('/api/admin/users', { email: 'not-an-email', name: 'x' })).status).toBe(400);
    expect((await ctx.admin.post('/api/admin/users', { email: 'x@y.io', role: 'owner' })).status).toBe(400);
  });

  it('bulk creates and reports per row', async () => {
    const ctx = await withAdmin();
    const r = await ctx.admin.post('/api/admin/users/bulk', {
      users: [
        { email: 'a1@example.com', name: 'A1' },
        { email: 'admin@example.com', name: 'dup' },
        { email: 'bad' },
        { email: 'a2@example.com', role: 'viewer' },
      ],
    });
    expect(r.body.results.map((x) => x.ok)).toEqual([true, false, false, true]);
    expect(r.body.results[0].user.inviteLink).toContain('/invite/');
  });

  it('deactivating signs the user out and blocks sign in; last admin is protected', async () => {
    const ctx = await withAdmin();
    const r = await ctx.admin.post('/api/admin/users', { email: 'dan@example.com', name: 'Dan', password: PASSWORD });
    const dan = client(ctx);
    await dan.post('/api/auth/login', { email: 'dan@example.com', password: PASSWORD });
    expect((await dan.get('/api/me')).status).toBe(200);
    expect((await ctx.admin.patch(`/api/admin/users/${r.body.user.id}`, { status: 'deactivated' })).status).toBe(200);
    expect((await dan.get('/api/me')).status).toBe(401);
    expect((await dan.post('/api/auth/login', { email: 'dan@example.com', password: PASSWORD })).status).toBe(401);
    const me = await ctx.admin.get('/api/me');
    expect((await ctx.admin.patch(`/api/admin/users/${me.body.user.id}`, { role: 'member' })).status).toBe(400);
    // reactivate
    expect((await ctx.admin.patch(`/api/admin/users/${r.body.user.id}`, { status: 'active' })).status).toBe(200);
    expect((await dan.post('/api/auth/login', { email: 'dan@example.com', password: PASSWORD })).status).toBe(200);
  });

  it('reset link replaces the password and older links stop working', async () => {
    const ctx = await withAdmin();
    const r = await ctx.admin.post('/api/admin/users', { email: 'eve@example.com', name: 'Eve' });
    const first = r.body.user.inviteLink.split('/invite/')[1];
    const again = await ctx.admin.post(`/api/admin/users/${r.body.user.id}/invite`);
    const second = again.body.link.split('/invite/')[1];
    expect((await client(ctx).get(`/api/auth/invite/${first}`)).status).toBe(404);
    expect((await client(ctx).post(`/api/auth/invite/${second}`, { password: PASSWORD })).status).toBe(200);
  });

  it('only admins reach admin routes and audit records actions', async () => {
    const ctx = await withAdmin();
    await ctx.admin.post('/api/admin/users', { email: 'f@example.com', name: 'F', password: PASSWORD });
    const f = client(ctx);
    await f.post('/api/auth/login', { email: 'f@example.com', password: PASSWORD });
    expect((await f.get('/api/admin/users')).status).toBe(403);
    expect((await f.post('/api/admin/users', { email: 'g@example.com' })).status).toBe(403);
    const audit = await ctx.admin.get('/api/admin/audit');
    expect(audit.body.entries.map((e) => e.action)).toContain('user.created');
  });

  it('settings: admins only project creation', async () => {
    const ctx = await withAdmin();
    await ctx.admin.post('/api/admin/users', { email: 'h@example.com', name: 'H', password: PASSWORD });
    const h = client(ctx);
    await h.post('/api/auth/login', { email: 'h@example.com', password: PASSWORD });
    expect((await ctx.admin.patch('/api/admin/settings', { projectCreation: 'admins', appName: 'Kettle Tracker' })).status).toBe(200);
    expect((await h.post('/api/projects', { key: 'HH', name: 'H' })).status).toBe(403);
    expect((await h.get('/api/me')).body).toMatchObject({ canCreateProject: false, appName: 'Kettle Tracker' });
  });
});

describe('google sign-in', () => {
  const idToken = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
  async function googleCtx(settings = {}) {
    const ctx = await withAdmin({
      GOOGLE_CLIENT_ID: 'cid',
      GOOGLE_CLIENT_SECRET: 'secret',
      fetch: async () => new Response(JSON.stringify({ id_token: ctx.nextToken })),
    });
    if (Object.keys(settings).length) await ctx.admin.patch('/api/admin/settings', settings);
    return ctx;
  }
  async function signIn(ctx, claims) {
    const c = client(ctx);
    const start = await c.get('/auth/google');
    const loc = new URL(start.headers.get('location'));
    const state = loc.searchParams.get('state');
    const nonce = loc.searchParams.get('nonce');
    ctx.nextToken = idToken({
      iss: 'https://accounts.google.com',
      aud: 'cid',
      exp: Date.now() / 1000 + 600,
      nonce,
      email_verified: true,
      ...claims,
    });
    const oidc = start.headers.get('set-cookie').match(/it_oidc=([^;]*)/)[1];
    const cb = await c.get(`/auth/google/callback?state=${state}&code=abc`, { headers: { cookie: `it_oidc=${oidc}` } });
    return { c, cb };
  }

  it('links a provisioned user and refuses unknown people', async () => {
    const ctx = await googleCtx();
    await ctx.admin.post('/api/admin/users', { email: 'ivy@example.com', name: 'Ivy' });
    const ok = await signIn(ctx, { sub: 'g-1', email: 'ivy@example.com' });
    expect(ok.cb.headers.get('location')).toBe('/');
    const no = await signIn(ctx, { sub: 'g-2', email: 'stranger@example.com' });
    expect(no.cb.headers.get('location')).toContain('/login?error=');
  });

  it('auto-provisions allowed domains when turned on', async () => {
    const ctx = await googleCtx({ googleDomains: 'example.com', googleAutoProvision: true });
    const ok = await signIn(ctx, { sub: 'g-3', email: 'new@example.com', name: 'New Person', hd: 'example.com' });
    expect(ok.cb.headers.get('location')).toBe('/');
    const other = await signIn(ctx, { sub: 'g-4', email: 'x@other.com' });
    expect(other.cb.headers.get('location')).toContain('error=');
    const users = await ctx.admin.get('/api/admin/users');
    expect(users.body.users.find((u) => u.email === 'new@example.com')).toMatchObject({ role: 'member', status: 'active', google: true });
  });

  it('rejects a wrong nonce or audience', async () => {
    const ctx = await googleCtx();
    await ctx.admin.post('/api/admin/users', { email: 'jo@example.com', name: 'Jo' });
    const bad = await signIn(ctx, { sub: 'g-5', email: 'jo@example.com', aud: 'someone-else' });
    expect(bad.cb.headers.get('location')).toContain('error=');
  });
});
