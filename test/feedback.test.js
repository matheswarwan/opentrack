import { describe, it, expect } from 'vitest';
import { withAdmin, addUser } from './helpers.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('feedback', () => {
  it('any user sends feedback; admins are notified and manage it', async () => {
    const ctx = await withAdmin();
    const viewer = await addUser(ctx, { email: 'v@example.com', name: 'Vera', role: 'viewer' });
    const r = await viewer.client.post('/api/feedback', {
      kind: 'bug',
      message: 'Board drag is slow',
      page: '/projects/CP/board',
      details: { browser: 'Chrome' },
      screenshot: PNG,
    });
    expect(r.status).toBe(201);
    const n = await ctx.admin.get('/api/notifications');
    expect(n.body.notifications[0]).toMatchObject({ type: 'feedback' });
    expect(n.body.notifications[0].message).toContain('Vera sent feedback (bug)');
    const list = await ctx.admin.get('/api/admin/feedback');
    expect(list.body.feedback[0]).toMatchObject({
      kind: 'bug',
      message: 'Board drag is slow',
      hasScreenshot: true,
      status: 'new',
      user: { name: 'Vera' },
      details: { browser: 'Chrome' },
    });
    expect(list.body.counts.new).toBe(1);
    const shot = await ctx.app.request(`/api/admin/feedback/${r.body.id}/screenshot`, { headers: { cookie: '' } }, ctx.env);
    expect(shot.status).toBe(401);
    expect((await ctx.admin.patch(`/api/admin/feedback/${r.body.id}`, { status: 'done', note: 'Fixed' })).status).toBe(200);
    const mine = await viewer.client.get('/api/feedback/mine');
    expect(mine.body.feedback[0]).toMatchObject({ status: 'done', adminNote: 'Fixed' });
    expect((await viewer.client.get('/api/admin/feedback')).status).toBe(403);
  });

  it('validates input', async () => {
    const ctx = await withAdmin();
    expect((await ctx.admin.post('/api/feedback', { message: '' })).status).toBe(400);
    expect((await ctx.admin.post('/api/feedback', { message: 'x', kind: 'rant' })).status).toBe(400);
    expect((await ctx.admin.post('/api/feedback', { message: 'x', screenshot: 'data:text/html;base64,PGI+' })).status).toBe(400);
    expect(
      (await ctx.admin.post('/api/feedback', { message: 'x', screenshot: 'data:image/png;base64,' + 'A'.repeat(1_600_000) })).status,
    ).toBe(400);
  });

  it('limits to 20 a day per person', async () => {
    const ctx = await withAdmin();
    for (let i = 0; i < 20; i++) await ctx.admin.post('/api/feedback', { message: `m${i}` });
    expect((await ctx.admin.post('/api/feedback', { message: 'one more' })).status).toBe(429);
  });
});
