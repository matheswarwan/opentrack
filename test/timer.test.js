// Issue timer: /api/me/timer (server/routes/timeTracking.js).
import { describe, it, expect } from 'vitest';
import { withAdmin, addUser } from './helpers.js';
import { elapsed } from '../server/lib/timeTracking.js';

const T0 = Date.parse('2026-11-18T09:00:00Z'); // a Wednesday
const MIN = 60000;

async function setup() {
  const ctx = await withAdmin({ now: T0 });
  const bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  await bob.client.post('/api/projects', { key: 'WEB', name: 'Website' });
  const mk = async (title) => (await bob.client.post('/api/issues', { projectKey: 'WEB', title })).body.issue.key;
  const a = await mk('First');
  const b = await mk('Second');
  const logs = async (key) => (await bob.client.get(`/api/issues/${key}`)).body.issue.worklogs;
  return { ctx, bob, a, b, logs };
}

describe('elapsed', () => {
  it('rounds up to whole minutes, at least one', () => {
    expect(elapsed('2026-11-18T09:00:00.000Z', T0)).toEqual({ minutes: 1, hours: 0.0167 });
    expect(elapsed('2026-11-18T09:00:00.000Z', T0 + 61000).minutes).toBe(2);
    expect(elapsed('2026-11-18T09:00:00.000Z', T0 + 90 * MIN)).toEqual({ minutes: 90, hours: 1.5 });
  });
});

describe('issue timer', () => {
  it('starts, shows and stops a timer, logging the elapsed time', async () => {
    const { ctx, bob, a, logs } = await setup();
    const c = bob.client;
    expect((await c.get('/api/me/timer')).body.timer).toBeNull();
    const s = await c.post('/api/me/timer/start', { issueKey: a });
    expect(s.status).toBe(201);
    expect(s.body.timer).toMatchObject({ issueKey: a, title: 'First', startedAt: new Date(T0).toISOString(), needsConfirm: false });
    expect(s.body.logged).toBeNull();

    ctx.env.now = T0 + 44 * MIN + 10000; // 44 min 10 s: rounds up to 45 minutes
    const g = await c.get('/api/me/timer');
    expect(g.body.timer).toMatchObject({ issueKey: a, minutes: 45, hours: 0.75 });
    expect(g.body.confirmAfterHours).toBe(12);

    // starting it again on the same issue keeps the running timer
    const again = await c.post('/api/me/timer/start', { issueKey: a });
    expect(again.status).toBe(200);
    expect(again.body.timer.startedAt).toBe(new Date(T0).toISOString());

    const stop = await c.post('/api/me/timer/stop', { note: 'Pairing' });
    expect(stop.status).toBe(200);
    expect(stop.body.logged).toMatchObject({ issueKey: a, hours: 0.75, workDate: '2026-11-18' });
    const w = await logs(a);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ hours: 0.75, note: 'Pairing', workDate: '2026-11-18', billable: true, source: null, mine: true });
    expect((await c.get('/api/me/timer')).body.timer).toBeNull();
    expect((await c.post('/api/me/timer/stop', {})).status).toBe(404);
  });

  it('takes a note, a date and the billable flag at stop time', async () => {
    const { ctx, bob, a, logs } = await setup();
    await bob.client.post('/api/me/timer/start', { issueKey: a });
    ctx.env.now = T0 + 30 * MIN;
    const stop = await bob.client.post('/api/me/timer/stop', { workDate: '2026-11-17', billable: false, hours: 0.25 });
    expect(stop.body.logged).toMatchObject({ hours: 0.25, workDate: '2026-11-17' });
    expect((await logs(a))[0]).toMatchObject({ hours: 0.25, workDate: '2026-11-17', billable: false, note: null });
    await bob.client.post('/api/me/timer/start', { issueKey: a });
    expect((await bob.client.post('/api/me/timer/stop', { hours: 30 })).status).toBe(400);
    expect((await bob.client.post('/api/me/timer/stop', { workDate: 'yesterday' })).status).toBe(400);
    expect((await bob.client.get('/api/me/timer')).body.timer).not.toBeNull(); // a refused stop keeps the timer
  });

  it('keeps one timer per person: starting another logs the first', async () => {
    const { ctx, bob, a, b, logs } = await setup();
    const c = bob.client;
    await c.post('/api/me/timer/start', { issueKey: a });
    ctx.env.now = T0 + 20 * MIN;
    const s = await c.post('/api/me/timer/start', { issueKey: b });
    expect(s.status).toBe(201);
    expect(s.body.logged).toMatchObject({ issueKey: a, minutes: 20 });
    expect(s.body.timer.issueKey).toBe(b);
    expect(await logs(a)).toHaveLength(1);
    expect((await logs(a))[0].hours).toBeCloseTo(0.3333, 4);
    expect(await logs(b)).toHaveLength(0);
    const n = await ctx.db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM timers');
    expect(n.n).toBe(1);
    // timers are per person: the admin has none
    expect((await ctx.admin.get('/api/me/timer')).body.timer).toBeNull();
    await ctx.admin.post('/api/me/timer/start', { issueKey: a });
    expect((await c.get('/api/me/timer')).body.timer.issueKey).toBe(b);
  });

  it('discards a timer without logging', async () => {
    const { bob, a, logs } = await setup();
    await bob.client.post('/api/me/timer/start', { issueKey: a });
    const d = await bob.client.del('/api/me/timer');
    expect(d.body).toEqual({ ok: true, discarded: true });
    expect((await bob.client.get('/api/me/timer')).body.timer).toBeNull();
    expect(await logs(a)).toHaveLength(0);
    expect((await bob.client.del('/api/me/timer')).body.discarded).toBe(false);
  });

  it('asks to confirm the hours of a timer over 12 hours', async () => {
    const { ctx, bob, a, b, logs } = await setup();
    const c = bob.client;
    await c.post('/api/me/timer/start', { issueKey: a });
    ctx.env.now = T0 + 15 * 60 * MIN;
    expect((await c.get('/api/me/timer')).body.timer).toMatchObject({ needsConfirm: true, hours: 15 });
    const blind = await c.post('/api/me/timer/stop', { note: 'Forgot it' });
    expect(blind.status).toBe(409);
    expect(blind.body).toMatchObject({ code: 'confirm_hours', hours: 15 });
    expect(await logs(a)).toHaveLength(0);
    // another timer cannot quietly log it either
    const other = await c.post('/api/me/timer/start', { issueKey: b });
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('timer_running');
    expect((await c.get('/api/me/timer')).body.timer.issueKey).toBe(a);
    const ok = await c.post('/api/me/timer/stop', { note: 'Forgot it', hours: 6.5 });
    expect(ok.status).toBe(200);
    expect((await logs(a))[0]).toMatchObject({ hours: 6.5, note: 'Forgot it' });
  });

  it('allows only people who can log work on the issue', async () => {
    const { ctx, bob, a } = await setup();
    const vic = await addUser(ctx, { email: 'vic@example.com', name: 'Vic', role: 'viewer' });
    const r = await vic.client.post('/api/me/timer/start', { issueKey: a });
    expect(r.status).toBe(403);
    expect((await vic.client.post(`/api/issues/${a}/worklogs`, { hours: 1 })).status).toBe(403); // the same rule
    // a private project: someone outside it does not learn the issue exists
    await bob.client.post('/api/projects', { key: 'SEC', name: 'Secret', visibility: 'private' });
    const hidden = (await bob.client.post('/api/issues', { projectKey: 'SEC', title: 'Hidden' })).body.issue.key;
    const cat = await addUser(ctx, { email: 'cat@example.com', name: 'Cat' });
    expect((await cat.client.post('/api/me/timer/start', { issueKey: hidden })).status).toBe(404);
    expect((await cat.client.post('/api/me/timer/start', {})).status).toBe(400);
    expect((await cat.client.post('/api/me/timer/start', { issueKey: 'NOPE-1' })).status).toBe(404);
  });

  it('cannot log a timer once the right to log work is gone, and replaces a timer on an issue in the Trash', async () => {
    const { ctx, bob, a, b, logs } = await setup();
    const cat = await addUser(ctx, { email: 'cat@example.com', name: 'Cat' });
    await cat.client.post('/api/me/timer/start', { issueKey: a });
    await ctx.admin.patch(`/api/admin/users/${cat.id}`, { role: 'viewer' });
    ctx.env.now = T0 + 10 * MIN;
    expect((await cat.client.post('/api/me/timer/stop', {})).status).toBe(403);
    expect(await logs(a)).toHaveLength(0);
    expect((await cat.client.del('/api/me/timer')).body.discarded).toBe(true);

    await bob.client.post('/api/me/timer/start', { issueKey: a });
    expect((await bob.client.del(`/api/issues/${a}`)).status).toBe(200); // to the Trash
    expect((await bob.client.get('/api/me/timer')).body.timer).toBeNull();
    const s = await bob.client.post('/api/me/timer/start', { issueKey: b });
    expect(s.status).toBe(201);
    expect(s.body.logged).toBeNull();
    expect((await bob.client.get('/api/me/timer')).body.timer.issueKey).toBe(b);
  });
});
