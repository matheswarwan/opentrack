import { describe, it, expect } from 'vitest';
import { withAdmin, addUser, client, PASSWORD } from './helpers.js';

const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const FIREFOX_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0';

async function signIn(ctx, email, ua) {
  const c = client(ctx);
  const r = await c.post('/api/auth/login', { email, password: PASSWORD }, { headers: ua ? { 'user-agent': ua } : {} });
  expect(r.status).toBe(200);
  return c;
}
const minutesAgo = (m) => new Date(Date.now() - m * 60e3).toISOString();

describe('active sessions', () => {
  it("lists the person's sessions with the browser and marks the current one", async () => {
    const ctx = await withAdmin();
    await addUser(ctx, { email: 'bob@example.com', name: 'Bob' }); // one session without a user agent
    const mac = await signIn(ctx, 'bob@example.com', CHROME_MAC);
    await signIn(ctx, 'bob@example.com', SAFARI_IPHONE);
    await signIn(ctx, 'bob@example.com', FIREFOX_WIN);
    const r = await mac.get('/api/me/sessions');
    expect(r.status).toBe(200);
    expect(r.body.sessions).toHaveLength(4);
    expect(r.body.sessions[0]).toMatchObject({ current: true, browser: 'Chrome on macOS' });
    expect(r.body.sessions.filter((s) => s.current)).toHaveLength(1);
    expect(r.body.sessions.map((s) => s.browser).sort()).toEqual([
      'Chrome on macOS',
      'Firefox on Windows',
      'Safari on iPhone',
      'Unknown browser',
    ]);
    for (const s of r.body.sessions) {
      expect(s.createdAt).toBeTruthy();
      expect(s.lastSeenAt).toBeTruthy();
    }
    // the ids shown are not the stored session ids, and other people's sessions are not listed
    const stored = (await ctx.db.all('SELECT id FROM sessions')).map((x) => x.id);
    expect(stored).toHaveLength(5);
    for (const s of r.body.sessions) expect(stored).not.toContain(s.id);
    expect((await ctx.admin.get('/api/me/sessions')).body.sessions).toHaveLength(1);
  });

  it('signs out one session, and everywhere else', async () => {
    const ctx = await withAdmin();
    await ctx.admin.post('/api/admin/users', { email: 'bob@example.com', name: 'Bob', password: PASSWORD });
    const a = await signIn(ctx, 'bob@example.com', CHROME_MAC);
    const b = await signIn(ctx, 'bob@example.com', SAFARI_IPHONE);
    const c = await signIn(ctx, 'bob@example.com', FIREFOX_WIN);
    const list = (await a.get('/api/me/sessions')).body.sessions;
    const phone = list.find((s) => s.browser === 'Safari on iPhone');
    // someone else cannot end it
    expect((await ctx.admin.del(`/api/me/sessions/${phone.id}`)).status).toBe(404);
    expect((await a.del(`/api/me/sessions/${phone.id}`)).status).toBe(200);
    expect((await b.get('/api/me')).status).toBe(401);
    expect((await c.get('/api/me')).status).toBe(200);
    expect((await a.del(`/api/me/sessions/${phone.id}`)).status).toBe(404);

    const others = await a.post('/api/me/sessions/revoke-others');
    expect(others.body).toMatchObject({ ok: true, count: 1 });
    expect((await c.get('/api/me')).status).toBe(401);
    expect((await a.get('/api/me')).status).toBe(200);
    expect((await a.get('/api/me/sessions')).body.sessions).toHaveLength(1);
    // the admin's session was never touched
    expect((await ctx.admin.get('/api/me')).status).toBe(200);
    // ending the current session signs this browser out
    const mine = (await a.get('/api/me/sessions')).body.sessions[0];
    expect((await a.del(`/api/me/sessions/${mine.id}`)).body.current).toBe(true);
    expect((await a.get('/api/me')).status).toBe(401);
  });

  it('changing the password signs out the other sessions, not this one', async () => {
    const ctx = await withAdmin();
    await ctx.admin.post('/api/admin/users', { email: 'bob@example.com', name: 'Bob', password: PASSWORD });
    const a = await signIn(ctx, 'bob@example.com');
    const b = await signIn(ctx, 'bob@example.com');
    expect((await a.post('/api/me/password', { currentPassword: 'wrong password!', newPassword: 'a brand new password' })).status).toBe(
      400,
    );
    expect((await b.get('/api/me')).status).toBe(200);
    expect((await a.post('/api/me/password', { currentPassword: PASSWORD, newPassword: 'a brand new password' })).status).toBe(200);
    expect((await a.get('/api/me')).status).toBe(200);
    expect((await b.get('/api/me')).status).toBe(401);
    expect((await client(ctx).post('/api/auth/login', { email: 'bob@example.com', password: 'a brand new password' })).status).toBe(200);
    const audit = await ctx.admin.get('/api/admin/audit');
    expect(audit.body.entries.map((e) => e.action)).toContain('user.password_changed');
  });

  it('admins sign a person out everywhere, audited', async () => {
    const ctx = await withAdmin();
    const bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
    const second = await signIn(ctx, 'bob@example.com');
    expect((await bob.client.post(`/api/admin/users/${bob.id}/sessions/revoke`)).status).toBe(403);
    const r = await ctx.admin.post(`/api/admin/users/${bob.id}/sessions/revoke`);
    expect(r.body).toMatchObject({ ok: true, count: 2 });
    expect((await bob.client.get('/api/me')).status).toBe(401);
    expect((await second.get('/api/me')).status).toBe(401);
    expect((await ctx.admin.post('/api/admin/users/nope/sessions/revoke')).status).toBe(404);
    const entry = (await ctx.admin.get('/api/admin/audit')).body.entries.find((e) => e.action === 'user.signed_out_everywhere');
    expect(entry).toMatchObject({ targetId: bob.id, details: { sessions: 2 } });
    // on yourself: your other sessions go, the one you are using stays
    const me = (await ctx.admin.get('/api/me')).body.user;
    const other = await signIn(ctx, 'admin@example.com');
    expect((await ctx.admin.post(`/api/admin/users/${me.id}/sessions/revoke`)).body.count).toBe(1);
    expect((await other.get('/api/me')).status).toBe(401);
    expect((await ctx.admin.get('/api/me')).status).toBe(200);
  });

  it('records last use at most every 5 minutes, and not for background requests', async () => {
    const ctx = await withAdmin();
    const seen = async () => (await ctx.db.get('SELECT last_seen_at FROM sessions')).last_seen_at;
    const first = await seen();
    expect(first).toBeTruthy();
    await ctx.admin.get('/api/me');
    expect(await seen()).toBe(first); // fresh: no write
    const old = minutesAgo(6);
    await ctx.db.run('UPDATE sessions SET last_seen_at = ?', [old]);
    await ctx.admin.get('/api/me', { headers: { 'x-background': '1' } }); // the notification bell's timer
    expect(await seen()).toBe(old);
    await ctx.admin.get('/api/me');
    expect((await seen()) > old).toBe(true);
    // a session from before the column existed counts from when it was created
    await ctx.db.run('UPDATE sessions SET last_seen_at = NULL');
    expect((await ctx.admin.get('/api/me')).status).toBe(200);
  });

  it('idle timeout: a session not used for that long is refused and removed', async () => {
    const ctx = await withAdmin();
    for (const bad of [-1, 5, 14, 10081, 30.5, '30'])
      expect((await ctx.admin.patch('/api/admin/settings', { idleTimeoutMinutes: bad })).status, String(bad)).toBe(400);
    expect((await ctx.admin.get('/api/admin/settings')).body.settings.idleTimeoutMinutes).toBe(0);
    await ctx.admin.post('/api/admin/users', { email: 'bob@example.com', name: 'Bob', password: PASSWORD });
    const bob = await signIn(ctx, 'bob@example.com');
    const bobId = (await bob.get('/api/me')).body.user.id;
    const setSeen = (m) => ctx.db.run('UPDATE sessions SET last_seen_at = ? WHERE user_id = ?', [minutesAgo(m), bobId]);

    // off: an old session keeps working
    await setSeen(3 * 24 * 60);
    expect((await bob.get('/api/me')).status).toBe(200);

    expect((await ctx.admin.patch('/api/admin/settings', { idleTimeoutMinutes: 30 })).status).toBe(200);
    expect((await bob.get('/api/me/sessions')).body.idleTimeoutMinutes).toBe(30);
    await setSeen(20);
    expect((await bob.get('/api/me')).status).toBe(200);
    // last use is written at most every 5 minutes, so the session ends between 30 and 35 minutes after it
    await setSeen(36);
    expect((await bob.get('/api/me', { headers: { 'x-background': '1' } })).status).toBe(401);
    expect((await ctx.db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM sessions WHERE user_id = ?', [bobId])).n).toBe(0);
    expect((await bob.get('/api/me')).status).toBe(401);
    // signing in again works
    expect((await (await signIn(ctx, 'bob@example.com')).get('/api/me')).status).toBe(200);
    // background requests alone do not keep a session alive
    const idle = await signIn(ctx, 'bob@example.com');
    await setSeen(29);
    expect((await idle.get('/api/me', { headers: { 'x-background': '1' } })).status).toBe(200);
    expect(
      (await ctx.db.get('SELECT last_seen_at FROM sessions WHERE user_id = ? ORDER BY last_seen_at LIMIT 1', [bobId])).last_seen_at <
        minutesAgo(28),
    ).toBe(true);
  });

  it('sessions are not available to API tokens', async () => {
    const ctx = await withAdmin();
    const bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
    const t = await bob.client.post('/api/me/tokens', { name: 'cli' });
    expect(t.status).toBe(201);
    const r = await client(ctx).get('/api/me/sessions', { headers: { authorization: `Bearer ${t.body.token}` } });
    expect(r.status).toBe(403);
  });
});
