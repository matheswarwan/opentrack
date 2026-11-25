import { describe, it, expect } from 'vitest';
import { withAdmin, client, PASSWORD } from './helpers.js';

describe('allowed email domains', () => {
  it('validates and cleans the setting', async () => {
    const ctx = await withAdmin();
    expect((await ctx.admin.get('/api/admin/settings')).body.settings.allowedDomains).toEqual([]);
    const r = await ctx.admin.patch('/api/admin/settings', { allowedDomains: [' Acme.com ', '@example.com', 'acme.com', ''] });
    expect(r.status).toBe(200);
    expect(r.body.settings.allowedDomains).toEqual(['acme.com', 'example.com']);
    // text (comma or space separated) is accepted too
    expect((await ctx.admin.patch('/api/admin/settings', { allowedDomains: 'a.io, b.io' })).body.settings.allowedDomains).toEqual([
      'a.io',
      'b.io',
    ]);
    for (const bad of [['not a domain'], ['nodot'], ['x@y.io'], [5], ['-a.io']]) {
      expect((await ctx.admin.patch('/api/admin/settings', { allowedDomains: bad })).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await ctx.admin.patch('/api/admin/settings', { allowedDomains: [] })).body.settings.allowedDomains).toEqual([]);
  });

  it('refuses creating, inviting and importing people outside the list', async () => {
    const ctx = await withAdmin();
    const old = await ctx.admin.post('/api/admin/users', { email: 'old@other.org', name: 'Old Invite' });
    await ctx.admin.post('/api/admin/users', { email: 'active@other.org', name: 'Active', password: PASSWORD });
    await ctx.admin.patch('/api/admin/settings', { allowedDomains: ['acme.com'] });

    const no = await ctx.admin.post('/api/admin/users', { email: 'eve@other.org', name: 'Eve' });
    expect(no.status).toBe(400);
    expect(no.body.error).toContain('eve@other.org is not in an allowed email domain (acme.com)');
    expect((await ctx.admin.post('/api/admin/users', { email: 'eve@other.org', name: 'Eve', password: PASSWORD })).status).toBe(400);
    // a look-alike domain does not pass
    expect((await ctx.admin.post('/api/admin/users', { email: 'eve@notacme.com', name: 'Eve' })).status).toBe(400);
    expect((await ctx.admin.post('/api/admin/users', { email: 'eve@acme.com.evil.io', name: 'Eve' })).status).toBe(400);
    expect((await ctx.admin.post('/api/admin/users', { email: 'Ann@ACME.com', name: 'Ann' })).status).toBe(201);

    const bulk = await ctx.admin.post('/api/admin/users/bulk', { users: [{ email: 'b1@acme.com' }, { email: 'b2@other.org' }] });
    expect(bulk.body.results.map((x) => x.ok)).toEqual([true, false]);
    expect(bulk.body.results[1].error).toContain('not in an allowed email domain');

    // an invited person outside the list gets no new invite link
    expect((await ctx.admin.post(`/api/admin/users/${old.body.user.id}/invite`)).status).toBe(400);
  });

  it('existing users outside the list keep working and are marked for admins', async () => {
    const ctx = await withAdmin();
    const r = await ctx.admin.post('/api/admin/users', { email: 'active@other.org', name: 'Active', password: PASSWORD });
    await ctx.admin.patch('/api/admin/settings', { allowedDomains: ['example.com'] });
    const c = client(ctx);
    expect((await c.post('/api/auth/login', { email: 'active@other.org', password: PASSWORD })).status).toBe(200);
    expect((await c.get('/api/me')).status).toBe(200);
    const list = await ctx.admin.get('/api/admin/users');
    expect(list.body.allowedDomains).toEqual(['example.com']);
    expect(list.body.users.find((u) => u.email === 'active@other.org').outsideDomains).toBe(true);
    expect(list.body.users.find((u) => u.email === 'admin@example.com').outsideDomains).toBe(false);
    // an active person can still get a password reset link and be edited
    expect((await ctx.admin.post(`/api/admin/users/${r.body.user.id}/invite`)).status).toBe(200);
    const edited = await ctx.admin.patch(`/api/admin/users/${r.body.user.id}`, { title: 'Contractor' });
    expect(edited.body.user.outsideDomains).toBe(true);
  });

  describe('google sign-in', () => {
    const idToken = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
    async function signIn(ctx, claims) {
      const c = client(ctx);
      const start = await c.get('/auth/google');
      const loc = new URL(start.headers.get('location'));
      ctx.nextToken = idToken({
        iss: 'https://accounts.google.com',
        aud: 'cid',
        exp: Date.now() / 1000 + 600,
        nonce: loc.searchParams.get('nonce'),
        email_verified: true,
        ...claims,
      });
      const oidc = start.headers.get('set-cookie').match(/it_oidc=([^;]*)/)[1];
      return c.get(`/auth/google/callback?state=${loc.searchParams.get('state')}&code=abc`, { headers: { cookie: `it_oidc=${oidc}` } });
    }

    it('does not create an account outside the list on first sign-in; existing users still sign in', async () => {
      const ctx = await withAdmin({
        GOOGLE_CLIENT_ID: 'cid',
        GOOGLE_CLIENT_SECRET: 'secret',
        fetch: async () => new Response(JSON.stringify({ id_token: ctx.nextToken })),
      });
      await ctx.admin.post('/api/admin/users', { email: 'known@other.org', name: 'Known' });
      await ctx.admin.patch('/api/admin/settings', {
        googleDomains: 'acme.com,other.org',
        googleAutoProvision: true,
        allowedDomains: ['acme.com'],
      });
      const refused = await signIn(ctx, { sub: 'g-1', email: 'new@other.org', hd: 'other.org' });
      expect(decodeURIComponent(refused.headers.get('location'))).toContain('Accounts from other.org cannot be created here');
      expect((await signIn(ctx, { sub: 'g-2', email: 'new@acme.com', hd: 'acme.com' })).headers.get('location')).toBe('/');
      expect((await signIn(ctx, { sub: 'g-3', email: 'known@other.org', hd: 'other.org' })).headers.get('location')).toBe('/');
      const users = (await ctx.admin.get('/api/admin/users')).body.users.map((u) => u.email);
      expect(users).toContain('new@acme.com');
      expect(users).not.toContain('new@other.org');
    });
  });
});
