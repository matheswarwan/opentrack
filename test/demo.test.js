import { describe, it, expect } from 'vitest';
import { withAdmin, client, makeEnv } from './helpers.js';
import { DEMO_EMAIL } from '../server/lib/demo.js';

async function demoClient(ctx) {
  const c = client(ctx);
  const r = await c.post('/api/auth/demo');
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  return c;
}

describe('public demo (DEMO_MODE)', () => {
  it('is off unless DEMO_MODE is set', async () => {
    const ctx = await withAdmin();
    expect((await client(ctx).get('/api/auth/config')).body.demo).toBe(false);
    expect((await client(ctx).post('/api/auth/demo')).status).toBe(404);
  });

  it('waits for setup, so the first admin is still made through /setup', async () => {
    const ctx = await makeEnv({ DEMO_MODE: 'true' });
    expect((await client(ctx).post('/api/auth/demo')).status).toBe(409);
    expect((await client(ctx).get('/api/auth/config')).body.needsSetup).toBe(true);
  });

  it('signs visitors in to one shared account with every feature', async () => {
    const ctx = await withAdmin({ DEMO_MODE: 'true' });
    expect((await client(ctx).get('/api/auth/config')).body.demo).toBe(true);
    const a = await demoClient(ctx);
    const b = await demoClient(ctx);
    const me = (await a.get('/api/me')).body;
    expect(me.user).toMatchObject({ email: DEMO_EMAIL, role: 'admin' });
    expect(me.demo).toBe(true);
    expect((await b.get('/api/me')).body.user.id).toBe(me.user.id);
    expect((await ctx.db.all('SELECT id FROM users WHERE email = ?', [DEMO_EMAIL])).length).toBe(1);

    // projects, issues and comments work as for anyone
    expect((await a.post('/api/projects', { key: 'demo', name: 'Demo' })).status).toBe(201);
    const issue = await a.post('/api/issues', { projectKey: 'DEMO', title: 'Try the board' });
    expect(issue.status).toBe(201);
    expect((await b.post(`/api/issues/${issue.body.issue.key}/comments`, { body: 'Looks good' })).status).toBe(201);
    expect((await a.post('/api/me/tokens', { name: 'AI', expiresInDays: 7 })).status).toBe(201);
    // the real admin is not affected
    expect((await ctx.admin.get('/api/me')).body.demo).toBe(false);
  });

  it('reads admin pages but cannot change them', async () => {
    const ctx = await withAdmin({ DEMO_MODE: 'true' });
    const d = await demoClient(ctx);
    for (const path of ['/api/admin/users', '/api/admin/settings', '/api/admin/audit', '/api/admin/webhooks', '/api/admin/backups']) {
      expect((await d.get(path)).status, path).toBe(200);
    }
    const before = (await d.get('/api/admin/settings')).body.settings;
    const tries = [
      d.patch('/api/admin/settings', { appName: 'Hacked' }),
      d.post('/api/admin/users', { email: 'x@example.com', name: 'X' }),
      d.patch(`/api/admin/users/${(await ctx.admin.get('/api/me')).body.user.id}`, { role: 'viewer' }),
      d.post('/api/admin/webhooks', { url: 'https://example.com/hook', events: ['issue.created'] }),
    ];
    for (const r of await Promise.all(tries)) {
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('demo_read_only');
    }
    expect((await ctx.admin.get('/api/admin/settings')).body.settings.appName).toBe(before.appName);
    // the real admin still changes settings
    expect((await ctx.admin.patch('/api/admin/settings', { appName: 'Team Tracker' })).status).toBe(200);
  });

  it('cannot change the shared account or send webhooks, so visitors cannot lock each other out', async () => {
    const ctx = await withAdmin({ DEMO_MODE: 'true' });
    const d = await demoClient(ctx);
    await d.post('/api/projects', { key: 'demo', name: 'Demo' });
    const tries = [
      d.patch('/api/me', { name: 'Someone else' }),
      d.post('/api/me/password', { newPassword: 'a new long password' }),
      d.post('/api/me/2fa/setup'),
      d.post('/api/me/sessions/revoke-others'),
      d.post('/api/projects/DEMO/webhooks', { url: 'https://example.com/hook', events: ['issue.created'] }),
    ];
    for (const r of await Promise.all(tries)) expect([r.status, r.body.code]).toEqual([403, 'demo_read_only']);
    expect((await d.get('/api/me')).body.user.name).toBe('Demo visitor');
    expect((await d.get('/api/me/sessions')).status).toBe(200);
  });

  it('stays off for the demo email when DEMO_MODE is not set', async () => {
    const ctx = await withAdmin();
    await ctx.admin.post('/api/admin/users', { email: DEMO_EMAIL, name: 'Not a demo', role: 'admin', password: 'correct horse battery' });
    const c = client(ctx);
    await c.post('/api/auth/login', { email: DEMO_EMAIL, password: 'correct horse battery' });
    expect((await c.get('/api/me')).body.demo).toBe(false);
    expect((await c.patch('/api/admin/settings', { appName: 'Fine' })).status).toBe(200);
  });
});
