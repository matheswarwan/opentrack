import { describe, it, expect } from 'vitest';
import { withAdmin, addUser, client, PASSWORD } from './helpers.js';
import { hotp, totp, base32Encode, base32Decode, matchingStep, otpauthUri, describeAgent } from '../server/lib/twofactor.js';

const ascii = (s) => new TextEncoder().encode(s);
const STEP = 30e3;

/** Turn two-factor on for a signed-in client; returns the secret and the recovery codes. The test clock is ctx.env.now. */
async function enable(ctx, c) {
  const setup = await c.post('/api/me/2fa/setup');
  expect(setup.status).toBe(200);
  const done = await c.post('/api/me/2fa/confirm', { code: await totp(setup.body.secret, ctx.env.now()) });
  expect(done.status).toBe(200);
  return { secret: setup.body.secret, uri: setup.body.uri, recoveryCodes: done.body.recoveryCodes };
}

/** An environment with a clock the test moves (codes are valid once, so each sign-in needs a later time step). */
async function setupCtx(extra) {
  const ctx = await withAdmin(extra);
  let t = Date.now();
  ctx.env.now = () => t;
  ctx.tick = (steps = 2) => {
    t += steps * STEP;
  };
  return ctx;
}

async function firstStep(ctx, email, password = PASSWORD) {
  const c = client(ctx);
  const r = await c.post('/api/auth/login', { email, password });
  return { c, r };
}

describe('TOTP (RFC 6238) and HOTP (RFC 4226)', () => {
  it('matches the RFC 4226 test values', async () => {
    const key = ascii('12345678901234567890');
    const want = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    for (let i = 0; i < want.length; i++) expect(await hotp(key, i)).toBe(want[i]);
  });

  it('matches the RFC 6238 test vectors (SHA-1, SHA-256, SHA-512; 8 digits)', async () => {
    const keys = {
      'SHA-1': ascii('12345678901234567890'),
      'SHA-256': ascii('12345678901234567890123456789012'),
      'SHA-512': ascii('1234567890123456789012345678901234567890123456789012345678901234'),
    };
    const vectors = [
      [59, '94287082', '46119246', '90693936'],
      [1111111109, '07081804', '68084774', '25091201'],
      [1111111111, '14050471', '67062674', '99943326'],
      [1234567890, '89005924', '91819424', '93441116'],
      [2000000000, '69279037', '90698825', '38618901'],
      [20000000000, '65353130', '77737706', '47863826'],
    ];
    for (const [time, sha1, sha256, sha512] of vectors) {
      const counter = Math.floor(time / 30);
      expect(await hotp(keys['SHA-1'], counter, { digits: 8, algorithm: 'SHA-1' }), `sha1 ${time}`).toBe(sha1);
      expect(await hotp(keys['SHA-256'], counter, { digits: 8, algorithm: 'SHA-256' }), `sha256 ${time}`).toBe(sha256);
      expect(await hotp(keys['SHA-512'], counter, { digits: 8, algorithm: 'SHA-512' }), `sha512 ${time}`).toBe(sha512);
    }
  });

  it('reads base32 secrets and gives the 6-digit code of the same vectors', async () => {
    const secret = base32Encode(ascii('12345678901234567890'));
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(Array.from(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq'))).toEqual(Array.from(ascii('12345678901234567890')));
    expect(Array.from(base32Decode(base32Encode(new Uint8Array([1, 2, 3, 250, 251]))))).toEqual([1, 2, 3, 250, 251]);
    expect(await totp(secret, 59e3)).toBe('287082');
    expect(await totp(secret, 1111111109e3)).toBe('081804');
    expect(await totp(secret, 20000000000e3)).toBe('353130');
  });

  it('allows one step of drift either way and no more; used steps never match again', async () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const t = 1111111109e3;
    const step = Math.floor(t / STEP);
    expect(await matchingStep(secret, await totp(secret, t), t)).toBe(step);
    expect(await matchingStep(secret, await totp(secret, t - STEP), t)).toBe(step - 1);
    expect(await matchingStep(secret, await totp(secret, t + STEP), t)).toBe(step + 1);
    expect(await matchingStep(secret, await totp(secret, t - 2 * STEP), t)).toBe(null);
    expect(await matchingStep(secret, await totp(secret, t + 2 * STEP), t)).toBe(null);
    expect(await matchingStep(secret, await totp(secret, t), t, step)).toBe(null);
    expect(await matchingStep(secret, await totp(secret, t - STEP), t, step)).toBe(null);
    expect(await matchingStep(secret, await totp(secret, t + STEP), t, step)).toBe(step + 1);
    for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined]) expect(await matchingStep(secret, bad, t)).toBe(null);
    expect(await matchingStep(secret, '081 804', t)).toBe(step); // apps show the code in two groups
  });

  it('builds the otpauth URI and names browsers', () => {
    const uri = otpauthUri('Opentrack', 'ada+x@example.com', 'ABC');
    expect(uri).toBe('otpauth://totp/Opentrack:ada%2Bx%40example.com?secret=ABC&issuer=Opentrack&algorithm=SHA1&digits=6&period=30');
    expect(
      describeAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
      ),
    ).toBe('Edge on Windows');
    expect(
      describeAgent('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'),
    ).toBe('Chrome on Android');
    expect(describeAgent('')).toBe('Unknown browser');
  });
});

describe('QR code for the setup (src/qr.js)', () => {
  it('draws a symbol with the three finder patterns and grows with the text', async () => {
    const { qrMatrix, qrPath } = await import('../src/qr.js');
    const uri = otpauthUri('Opentrack', 'ada@example.com', 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    const m = qrMatrix(uri);
    expect(m.length).toBe(m[0].length);
    expect((m.length - 17) % 4).toBe(0);
    expect(m.length).toBeGreaterThan(qrMatrix('a').length);
    expect(qrMatrix('a').length).toBe(21);
    const finder = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'];
    const at = (x0, y0) =>
      finder.map((_, y) =>
        m[y0 + y]
          .slice(x0, x0 + 7)
          .map((d) => (d ? '1' : '0'))
          .join(''),
      );
    expect(at(0, 0)).toEqual(finder);
    expect(at(m.length - 7, 0)).toEqual(finder);
    expect(at(0, m.length - 7)).toEqual(finder);
    expect(qrMatrix(uri)).toEqual(m); // same text, same symbol
    expect(qrPath(m)).toMatch(/^M4 4h7v1h-7z/);
    expect(() => qrMatrix('x'.repeat(413))).toThrow(/too long/);
  });
});

describe('turning two-factor on', () => {
  it('makes a secret, needs a code to confirm and shows 10 recovery codes once', async () => {
    const ctx = await setupCtx();
    const bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
    expect((await bob.client.get('/api/me/2fa')).body).toMatchObject({
      enabled: false,
      hasPassword: true,
      recoveryCodesLeft: 0,
      required: false,
    });
    expect((await bob.client.post('/api/me/2fa/confirm', { code: '123456' })).status).toBe(400); // nothing started

    const setup = await bob.client.post('/api/me/2fa/setup');
    expect(setup.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.body.uri).toContain(`secret=${setup.body.secret}`);
    expect(setup.body.uri).toContain('bob%40example.com');
    // not on yet: signing in still needs only the password
    expect((await bob.client.get('/api/me')).body.user.twoFactor).toBe(false);
    expect((await firstStep(ctx, 'bob@example.com')).r.body).toEqual({ ok: true });

    const wrong = await bob.client.post('/api/me/2fa/confirm', { code: '000000' });
    expect(wrong.status).toBe(400);
    const done = await bob.client.post('/api/me/2fa/confirm', { code: await totp(setup.body.secret, ctx.env.now()) });
    expect(done.status).toBe(200);
    expect(done.body.recoveryCodes).toHaveLength(10);
    expect(new Set(done.body.recoveryCodes).size).toBe(10);
    for (const code of done.body.recoveryCodes) expect(code).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);

    expect((await bob.client.get('/api/me')).body.user.twoFactor).toBe(true);
    expect((await bob.client.get('/api/me/2fa')).body).toMatchObject({ enabled: true, recoveryCodesLeft: 10 });
    expect((await bob.client.post('/api/me/2fa/setup')).status).toBe(409);
    expect((await bob.client.post('/api/me/2fa/confirm', { code: '123456' })).status).toBe(409);

    // only hashes are stored; the admin list shows who has it on; the action is audited
    const stored = await ctx.db.all('SELECT code_hash FROM recovery_codes');
    expect(stored).toHaveLength(10);
    for (const row of stored) for (const code of done.body.recoveryCodes) expect(row.code_hash).not.toContain(code.replace('-', ''));
    const list = (await ctx.admin.get('/api/admin/users')).body.users;
    expect(list.find((u) => u.email === 'bob@example.com').twoFactor).toBe(true);
    expect(list.find((u) => u.email === 'admin@example.com').twoFactor).toBe(false);
    expect((await ctx.admin.get('/api/admin/audit')).body.entries.map((e) => e.action)).toContain('user.2fa_enabled');
    // nothing of it reaches other people or the people picker
    expect(JSON.stringify((await ctx.admin.get('/api/admin/users')).body)).not.toContain(setup.body.secret);
  });

  it('a backup holds no secret, recovery code hash or pending sign-in', async () => {
    const ctx = await setupCtx();
    const bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
    const { secret } = await enable(ctx, bob.client);
    await firstStep(ctx, 'bob@example.com'); // leaves a pending sign-in
    const r = await ctx.admin.get('/api/admin/backup');
    expect(r.status).toBe(200);
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    expect(text).toContain('bob@example.com');
    expect(text).not.toContain(secret);
    for (const word of ['totp_secret', 'totp_last_step', 'totp_enabled_at', 'recovery_codes', 'login_challenges'])
      expect(text).not.toContain(`"${word}"`);
    for (const row of await ctx.db.all('SELECT code_hash AS h FROM recovery_codes UNION ALL SELECT id AS h FROM login_challenges'))
      expect(text).not.toContain(row.h);
  });

  it('is not offered to people who only sign in with Google, or to API tokens', async () => {
    const ctx = await setupCtx();
    const bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
    const t = await bob.client.post('/api/me/tokens', { name: 'cli' });
    expect((await client(ctx).post('/api/me/2fa/setup', {}, { headers: { authorization: `Bearer ${t.body.token}` } })).status).toBe(403);
    await ctx.db.run('UPDATE users SET password_hash = NULL WHERE email = ?', ['bob@example.com']);
    const r = await bob.client.post('/api/me/2fa/setup');
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('Google');
  });
});

describe('signing in with two-factor', () => {
  it('asks for the code in a second step and creates no session before it', async () => {
    const ctx = await setupCtx();
    const bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
    const { secret } = await enable(ctx, bob.client);
    const sessions = async () =>
      (
        await ctx.db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = ?', [
          'bob@example.com',
        ])
      ).n;
    expect(await sessions()).toBe(1);

    ctx.tick();
    const { c, r } = await firstStep(ctx, 'bob@example.com');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, twoFactor: true });
    expect(r.body.pendingToken).toBeTruthy();
    expect(r.headers.get('set-cookie')).toBeNull();
    expect(await sessions()).toBe(1);
    expect((await c.get('/api/me')).status).toBe(401);
    // the token is stored hashed
    expect((await ctx.db.all('SELECT id FROM login_challenges')).map((x) => x.id)).not.toContain(r.body.pendingToken);

    expect((await c.post('/api/auth/login/2fa', { pendingToken: r.body.pendingToken, code: '000000' })).status).toBe(401);
    expect((await c.post('/api/auth/login/2fa', { pendingToken: 'not-a-token', code: await totp(secret, ctx.env.now()) })).status).toBe(
      401,
    );
    expect((await c.post('/api/auth/login/2fa', { code: await totp(secret, ctx.env.now()) })).status).toBe(401);
    expect((await c.get('/api/me')).status).toBe(401);
    // the CSRF header is needed like on the first step
    expect(
      (
        await c.post(
          '/api/auth/login/2fa',
          { pendingToken: r.body.pendingToken, code: await totp(secret, ctx.env.now()) },
          { noCsrf: true },
        )
      ).status,
    ).toBe(403);

    const ok = await c.post('/api/auth/login/2fa', { pendingToken: r.body.pendingToken, code: await totp(secret, ctx.env.now()) });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
    expect((await c.get('/api/me')).body.user).toMatchObject({ email: 'bob@example.com', twoFactor: true });
    expect(await sessions()).toBe(2);
    // the pending token is single use
    ctx.tick();
    expect(
      (await client(ctx).post('/api/auth/login/2fa', { pendingToken: r.body.pendingToken, code: await totp(secret, ctx.env.now()) }))
        .status,
    ).toBe(401);
    // a wrong password never reaches the second step
    expect((await firstStep(ctx, 'bob@example.com', 'wrong password!')).r.status).toBe(401);
  });

  it('refuses a code that was used already, accepts one step of drift, and expires the pending token', async () => {
    const ctx = await setupCtx();
    const bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
    const { secret } = await enable(ctx, bob.client);

    // the code that confirmed the setup cannot sign in
    const a = await firstStep(ctx, 'bob@example.com');
    const used = await totp(secret, ctx.env.now());
    expect((await a.c.post('/api/auth/login/2fa', { pendingToken: a.r.body.pendingToken, code: used })).status).toBe(401);
    // the next step's code (a phone running 30 s fast) works, once
    const next = await totp(secret, ctx.env.now() + STEP);
    expect((await a.c.post('/api/auth/login/2fa', { pendingToken: a.r.body.pendingToken, code: next })).status).toBe(200);
    const b = await firstStep(ctx, 'bob@example.com');
    expect((await b.c.post('/api/auth/login/2fa', { pendingToken: b.r.body.pendingToken, code: next })).status).toBe(401);
    // two steps off is refused; one step behind (a slow phone) is fine once the clock has moved on
    ctx.tick(4);
    expect(
      (await b.c.post('/api/auth/login/2fa', { pendingToken: b.r.body.pendingToken, code: await totp(secret, ctx.env.now() + 2 * STEP) }))
        .status,
    ).toBe(401);
    expect(
      (await b.c.post('/api/auth/login/2fa', { pendingToken: b.r.body.pendingToken, code: await totp(secret, ctx.env.now() - 2 * STEP) }))
        .status,
    ).toBe(401);
    expect(
      (await b.c.post('/api/auth/login/2fa', { pendingToken: b.r.body.pendingToken, code: await totp(secret, ctx.env.now() - STEP) }))
        .status,
    ).toBe(200);

    // a pending token lasts 5 minutes
    ctx.tick(4);
    const late = await firstStep(ctx, 'bob@example.com');
    const row = await ctx.db.get('SELECT created_at, expires_at FROM login_challenges');
    expect(Math.round((new Date(row.expires_at) - new Date(row.created_at)) / 60e3)).toBe(5);
    await ctx.db.run('UPDATE login_challenges SET expires_at = ?', [new Date(Date.now() - 1000).toISOString()]);
    const expired = await late.c.post('/api/auth/login/2fa', {
      pendingToken: late.r.body.pendingToken,
      code: await totp(secret, ctx.env.now()),
    });
    expect(expired.status).toBe(401);
    expect(expired.body.code).toBe('challenge_expired');
  });

  it('recovery codes work once each', async () => {
    const ctx = await setupCtx();
    const bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
    const { recoveryCodes } = await enable(ctx, bob.client);
    const a = await firstStep(ctx, 'bob@example.com');
    // typed in capitals and without the dash
    const ok = await a.c.post('/api/auth/login/2fa', {
      pendingToken: a.r.body.pendingToken,
      code: recoveryCodes[0].replace('-', '').toUpperCase(),
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, recoveryCodesLeft: 9 });
    expect((await a.c.get('/api/me')).status).toBe(200);
    const b = await firstStep(ctx, 'bob@example.com');
    expect((await b.c.post('/api/auth/login/2fa', { pendingToken: b.r.body.pendingToken, code: recoveryCodes[0] })).status).toBe(401);
    expect((await b.c.post('/api/auth/login/2fa', { pendingToken: b.r.body.pendingToken, code: 'aaaaa-bbbbb' })).status).toBe(401);
    expect((await b.c.post('/api/auth/login/2fa', { pendingToken: b.r.body.pendingToken, code: recoveryCodes[1] })).status).toBe(200);
    expect((await bob.client.get('/api/me/2fa')).body.recoveryCodesLeft).toBe(8);
    // someone else's recovery code is no use
    const eve = await addUser(ctx, { email: 'eve@example.com', name: 'Eve' });
    await enable(ctx, eve.client);
    const e = await firstStep(ctx, 'eve@example.com');
    expect((await e.c.post('/api/auth/login/2fa', { pendingToken: e.r.body.pendingToken, code: recoveryCodes[2] })).status).toBe(401);
  });

  it('new recovery codes replace the old ones and need a code or the password', async () => {
    const ctx = await setupCtx();
    const bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
    const { secret, recoveryCodes } = await enable(ctx, bob.client);
    expect((await bob.client.post('/api/me/2fa/recovery-codes', {})).status).toBe(400);
    expect((await bob.client.post('/api/me/2fa/recovery-codes', { password: 'wrong password!' })).status).toBe(400);
    ctx.tick();
    const fresh = await bob.client.post('/api/me/2fa/recovery-codes', { code: await totp(secret, ctx.env.now()) });
    expect(fresh.status).toBe(200);
    expect(fresh.body.recoveryCodes).toHaveLength(10);
    const a = await firstStep(ctx, 'bob@example.com');
    expect((await a.c.post('/api/auth/login/2fa', { pendingToken: a.r.body.pendingToken, code: recoveryCodes[0] })).status).toBe(401);
    expect((await a.c.post('/api/auth/login/2fa', { pendingToken: a.r.body.pendingToken, code: fresh.body.recoveryCodes[0] })).status).toBe(
      200,
    );
    expect((await bob.client.post('/api/me/2fa/recovery-codes', { password: PASSWORD })).body.recoveryCodes).toHaveLength(10);
  });

  it('wrong codes count toward the lockout, and a right password does not reset the count', async () => {
    const ctx = await setupCtx();
    const bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
    const { secret } = await enable(ctx, bob.client);
    ctx.tick();
    for (let i = 0; i < 5; i++) {
      const { c, r } = await firstStep(ctx, 'bob@example.com'); // right password each time
      expect(r.status).toBe(200);
      expect((await c.post('/api/auth/login/2fa', { pendingToken: r.body.pendingToken, code: '000000' })).status).toBe(401);
      expect((await c.post('/api/auth/login/2fa', { pendingToken: r.body.pendingToken, code: 'aaaaa-aaaaa' })).status).toBe(401);
    }
    expect((await ctx.db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM login_failures WHERE email = ?', ['bob@example.com'])).n).toBe(10);
    // locked: the password step and the code step both refuse, even with the right answers
    expect((await firstStep(ctx, 'bob@example.com')).r.status).toBe(429);
    const pending = (await ctx.db.all('SELECT id FROM login_challenges')).length;
    expect(pending).toBeGreaterThan(0);
    // a pending token from before the lockout is refused with a right code too
    await ctx.db.run('DELETE FROM login_failures');
    const { c, r } = await firstStep(ctx, 'bob@example.com');
    for (let i = 0; i < 10; i++) await c.post('/api/auth/login/2fa', { pendingToken: r.body.pendingToken, code: '000000' });
    expect(
      (await c.post('/api/auth/login/2fa', { pendingToken: r.body.pendingToken, code: await totp(secret, ctx.env.now()) })).status,
    ).toBe(429);
    expect((await c.get('/api/me')).status).toBe(401);
    // a full sign-in clears the count
    await ctx.db.run('DELETE FROM login_failures');
    const again = await firstStep(ctx, 'bob@example.com');
    await again.c.post('/api/auth/login/2fa', { pendingToken: again.r.body.pendingToken, code: '000000' });
    expect(
      (await again.c.post('/api/auth/login/2fa', { pendingToken: again.r.body.pendingToken, code: await totp(secret, ctx.env.now()) }))
        .status,
    ).toBe(200);
    expect((await ctx.db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM login_failures')).n).toBe(0);
  });

  it('a password reset link does not skip the code', async () => {
    const ctx = await setupCtx();
    const bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
    const { secret } = await enable(ctx, bob.client);
    const link = await ctx.admin.post(`/api/admin/users/${bob.id}/invite`);
    const token = link.body.link.split('/invite/')[1];
    const c = client(ctx);
    const r = await c.post(`/api/auth/invite/${token}`, { password: 'a brand new password' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ twoFactor: true });
    expect((await c.get('/api/me')).status).toBe(401);
    ctx.tick();
    expect(
      (await c.post('/api/auth/login/2fa', { pendingToken: r.body.pendingToken, code: await totp(secret, ctx.env.now()) })).status,
    ).toBe(200);
    expect((await c.get('/api/me')).status).toBe(200);
  });

  it('Google sign-in is not asked for a code', async () => {
    const idToken = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
    const ctx = await setupCtx({
      GOOGLE_CLIENT_ID: 'cid',
      GOOGLE_CLIENT_SECRET: 'secret',
      fetch: async () => new Response(JSON.stringify({ id_token: ctx.nextToken })),
    });
    const bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
    await enable(ctx, bob.client);
    const c = client(ctx);
    const start = await c.get('/auth/google');
    const loc = new URL(start.headers.get('location'));
    ctx.nextToken = idToken({
      iss: 'https://accounts.google.com',
      aud: 'cid',
      exp: Date.now() / 1000 + 600,
      nonce: loc.searchParams.get('nonce'),
      email_verified: true,
      sub: 'g-1',
      email: 'bob@example.com',
    });
    const oidc = start.headers.get('set-cookie').match(/it_oidc=([^;]*)/)[1];
    const cb = await c.get(`/auth/google/callback?state=${loc.searchParams.get('state')}&code=abc`, {
      headers: { cookie: `it_oidc=${oidc}` },
    });
    expect(cb.headers.get('location')).toBe('/');
    expect(cb.headers.get('set-cookie')).toContain('it_session=');
  });
});

describe('turning two-factor off', () => {
  it('needs a current code or the password, and signs out the other sessions', async () => {
    const ctx = await setupCtx();
    const bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
    const { secret } = await enable(ctx, bob.client);
    ctx.tick();
    const a = await firstStep(ctx, 'bob@example.com');
    expect(
      (await a.c.post('/api/auth/login/2fa', { pendingToken: a.r.body.pendingToken, code: await totp(secret, ctx.env.now()) })).status,
    ).toBe(200);

    expect((await bob.client.post('/api/me/2fa/disable', {})).status).toBe(400);
    expect((await bob.client.post('/api/me/2fa/disable', { code: '000000' })).status).toBe(400);
    expect((await bob.client.post('/api/me/2fa/disable', { password: 'wrong password!' })).status).toBe(400);
    // the code that just signed in was used: it cannot turn two-factor off
    expect((await bob.client.post('/api/me/2fa/disable', { code: await totp(secret, ctx.env.now()) })).status).toBe(400);
    expect((await bob.client.get('/api/me/2fa')).body.enabled).toBe(true);
    ctx.tick();
    expect((await bob.client.post('/api/me/2fa/disable', { code: await totp(secret, ctx.env.now()) })).status).toBe(200);

    expect((await bob.client.get('/api/me/2fa')).body).toMatchObject({ enabled: false, recoveryCodesLeft: 0 });
    expect((await bob.client.get('/api/me')).status).toBe(200);
    expect((await a.c.get('/api/me')).status).toBe(401);
    expect(await ctx.db.get('SELECT totp_secret, totp_enabled_at, totp_last_step FROM users WHERE email = ?', ['bob@example.com'])).toEqual(
      { totp_secret: null, totp_enabled_at: null, totp_last_step: null },
    );
    expect(await ctx.db.all('SELECT id FROM recovery_codes')).toHaveLength(0);
    expect((await firstStep(ctx, 'bob@example.com')).r.body).toEqual({ ok: true });
    expect((await ctx.admin.get('/api/admin/audit')).body.entries.map((e) => e.action)).toContain('user.2fa_disabled');

    // with the password
    await enable(ctx, bob.client);
    expect((await bob.client.post('/api/me/2fa/disable', { password: PASSWORD })).status).toBe(200);
    expect((await bob.client.get('/api/me/2fa')).body.enabled).toBe(false);
    // a setup that was started and never confirmed is dropped without proof
    await bob.client.post('/api/me/2fa/setup');
    expect((await bob.client.post('/api/me/2fa/disable', {})).status).toBe(200);
    expect((await ctx.db.get('SELECT totp_secret FROM users WHERE email = ?', ['bob@example.com'])).totp_secret).toBeNull();
  });

  it('wrong answers when turning it off count toward the lockout', async () => {
    const ctx = await setupCtx();
    const bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
    await enable(ctx, bob.client);
    for (let i = 0; i < 10; i++) expect((await bob.client.post('/api/me/2fa/disable', { code: '000000' })).status).toBe(400);
    expect((await bob.client.post('/api/me/2fa/disable', { password: PASSWORD })).status).toBe(429);
    expect((await bob.client.get('/api/me/2fa')).body.enabled).toBe(true);
  });

  it("an admin resets a person's two-factor (audited); the person is signed out and signs in with the password", async () => {
    const ctx = await setupCtx();
    const bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
    const eve = await addUser(ctx, { email: 'eve@example.com', name: 'Eve' });
    expect((await ctx.admin.post(`/api/admin/users/${bob.id}/2fa/reset`)).status).toBe(400); // not on
    await enable(ctx, bob.client);
    const pending = await firstStep(ctx, 'bob@example.com');
    expect((await eve.client.post(`/api/admin/users/${bob.id}/2fa/reset`)).status).toBe(403);
    expect((await ctx.admin.post('/api/admin/users/nope/2fa/reset')).status).toBe(404);
    expect((await ctx.admin.post(`/api/admin/users/${bob.id}/2fa/reset`)).status).toBe(200);
    expect((await bob.client.get('/api/me')).status).toBe(401);
    expect((await ctx.admin.get('/api/admin/users')).body.users.find((u) => u.id === bob.id).twoFactor).toBe(false);
    expect(await ctx.db.all('SELECT id FROM recovery_codes')).toHaveLength(0);
    // a sign-in that was waiting for a code is gone too
    expect((await pending.c.post('/api/auth/login/2fa', { pendingToken: pending.r.body.pendingToken, code: '123456' })).status).toBe(401);
    const again = await firstStep(ctx, 'bob@example.com');
    expect(again.r.body).toEqual({ ok: true });
    expect((await again.c.get('/api/me')).body.user.twoFactor).toBe(false);
    const entry = (await ctx.admin.get('/api/admin/audit')).body.entries.find((e) => e.action === 'user.2fa_reset');
    expect(entry).toMatchObject({ targetId: bob.id, actorName: 'Ada Admin' });
  });
});

describe('require two-factor for admins', () => {
  it('an admin without it can only set it up; members and admins with it are not affected', async () => {
    const ctx = await setupCtx();
    const bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
    const amy = await addUser(ctx, { email: 'amy@example.com', name: 'Amy', role: 'admin' });
    await enable(ctx, amy.client);
    expect((await ctx.admin.get('/api/admin/settings')).body.settings.require2faAdmins).toBe(false);
    expect((await ctx.admin.patch('/api/admin/settings', { require2faAdmins: 'yes' })).status).toBe(400);
    expect((await ctx.admin.patch('/api/admin/settings', { require2faAdmins: true })).status).toBe(200);

    // the first admin has no two-factor: everything but the setup is refused
    const me = await ctx.admin.get('/api/me');
    expect(me.status).toBe(200);
    expect(me.body.twoFactorRequired).toBe(true);
    for (const r of [
      await ctx.admin.get('/api/projects'),
      await ctx.admin.get('/api/admin/users'),
      await ctx.admin.post('/api/projects', { key: 'AB', name: 'x' }),
      await ctx.admin.patch('/api/admin/settings', { require2faAdmins: false }),
      await ctx.admin.get('/api/me/sessions'),
    ]) {
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('two_factor_required');
    }
    expect((await ctx.admin.get('/api/me/2fa')).body).toMatchObject({ enabled: false, required: true });
    // members, and admins who have it, carry on
    expect((await bob.client.get('/api/projects')).status).toBe(200);
    expect((await bob.client.get('/api/me')).body.twoFactorRequired).toBe(false);
    expect((await amy.client.get('/api/admin/users')).status).toBe(200);
    expect((await amy.client.get('/api/me')).body.twoFactorRequired).toBe(false);
    // a fresh sign-in of that admin is in the same place
    const again = await firstStep(ctx, 'admin@example.com');
    expect(again.r.body).toEqual({ ok: true });
    expect((await again.c.get('/api/projects')).status).toBe(403);

    await enable(ctx, ctx.admin);
    expect((await ctx.admin.get('/api/me')).body.twoFactorRequired).toBe(false);
    expect((await ctx.admin.get('/api/admin/users')).status).toBe(200);
    // signing out still works for a blocked admin, and turning it off blocks again
    expect((await ctx.admin.post('/api/me/2fa/disable', { password: PASSWORD })).status).toBe(200);
    expect((await ctx.admin.get('/api/projects')).status).toBe(403);
    expect((await ctx.admin.post('/api/auth/logout')).status).toBe(200);
  });

  it('does not apply to admins who only sign in with Google (no password)', async () => {
    const ctx = await setupCtx();
    const amy = await addUser(ctx, { email: 'amy@example.com', name: 'Amy', role: 'admin' });
    await ctx.db.run('UPDATE users SET password_hash = NULL, google_sub = ? WHERE email = ?', ['g-amy', 'amy@example.com']);
    await ctx.db.run(`INSERT INTO settings (key, value) VALUES ('require2faAdmins', 'true')`);
    expect((await amy.client.get('/api/me')).body.twoFactorRequired).toBe(false);
    expect((await amy.client.get('/api/admin/users')).status).toBe(200);
    expect((await ctx.admin.get('/api/admin/users')).status).toBe(403);
  });
});
