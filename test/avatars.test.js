import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser, client } from './helpers.js';

// 1x1 PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString('base64')}`;

let ctx, bob, carol;
beforeEach(async () => {
  ctx = await withAdmin();
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
});

describe('profile photos', () => {
  it('uploads, serves and removes a photo', async () => {
    expect((await bob.client.get('/api/me')).body.user.avatarUrl).toBeNull();
    const up = await bob.client.put('/api/me/avatar', { image: PNG });
    expect(up.status).toBe(200);
    expect(up.body.avatarUrl).toMatch(new RegExp(`^/api/users/${bob.id}/avatar\\?v=`));
    expect((await bob.client.get('/api/me')).body.user.avatarUrl).toBe(up.body.avatarUrl);

    const img = await carol.client.get(up.body.avatarUrl);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(img.headers.get('cache-control')).toBe('private, max-age=86400');
    expect(img.headers.get('content-security-policy')).toBe("default-src 'none'");

    // a new upload changes the URL
    const up2 = await bob.client.put('/api/me/avatar', { image: JPEG });
    expect(up2.body.avatarUrl).not.toBe(up.body.avatarUrl);
    expect((await carol.client.get(up2.body.avatarUrl)).headers.get('content-type')).toBe('image/jpeg');

    expect((await bob.client.del('/api/me/avatar')).status).toBe(200);
    expect((await bob.client.get('/api/me')).body.user.avatarUrl).toBeNull();
    expect((await carol.client.get(`/api/users/${bob.id}/avatar`)).status).toBe(404);
  });

  it('needs a signed-in user to see a photo', async () => {
    const up = await bob.client.put('/api/me/avatar', { image: PNG });
    expect((await client(ctx).get(up.body.avatarUrl)).status).toBe(401);
  });

  it('rejects bad uploads', async () => {
    const bad = async (image) => (await bob.client.put('/api/me/avatar', { image })).status;
    expect(await bad(undefined)).toBe(400);
    expect(await bad('not a data url')).toBe(400);
    expect(await bad('data:image/gif;base64,R0lGODlhAQABAAAAACw=')).toBe(400);
    expect(await bad(`data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`)).toBe(400);
    expect(await bad(`data:image/png;base64,${Buffer.from('hello world, not a png').toString('base64')}`)).toBe(400);
    const big = Buffer.alloc(210 * 1024, 1);
    big.set([0x89, 0x50, 0x4e, 0x47]);
    expect(await bad(`data:image/png;base64,${big.toString('base64')}`)).toBe(400);
  });

  it('admins can remove a photo; others cannot', async () => {
    await bob.client.put('/api/me/avatar', { image: PNG });
    expect((await carol.client.del(`/api/admin/users/${bob.id}/avatar`)).status).toBe(403);
    expect((await ctx.admin.del(`/api/admin/users/${bob.id}/avatar`)).status).toBe(200);
    const users = (await ctx.admin.get('/api/admin/users')).body.users;
    expect(users.find((u) => u.id === bob.id).avatarUrl).toBeNull();
    const auditLog = (await ctx.admin.get('/api/admin/audit')).body.entries;
    expect(auditLog.some((e) => e.action === 'user.avatar_removed' && e.targetId === bob.id)).toBe(true);
  });

  it('avatarUrl appears in users, issues, comments, members and the activity feed', async () => {
    const { avatarUrl } = (await bob.client.put('/api/me/avatar', { image: PNG })).body;
    const users = (await carol.client.get('/api/users')).body.users;
    expect(users.find((u) => u.id === bob.id).avatarUrl).toBe(avatarUrl);
    expect(users.find((u) => u.id === carol.id).avatarUrl).toBeNull();
    expect((await ctx.admin.get('/api/admin/users')).body.users.find((u) => u.id === bob.id).avatarUrl).toBe(avatarUrl);

    const proj = (await bob.client.post('/api/projects', { key: 'WEB', name: 'Website' })).body.project;
    expect(proj.members.find((m) => m.userId === bob.id).avatarUrl).toBe(avatarUrl);
    const created = await bob.client.post('/api/issues', { projectKey: 'WEB', title: 'One', assigneeId: bob.id });
    const key = created.body.issue.key;
    expect(created.body.issue.reporter.avatarUrl).toBe(avatarUrl);
    const cm = await bob.client.post(`/api/issues/${key}/comments`, { body: 'hi' });
    expect(cm.body.comment.author.avatarUrl).toBe(avatarUrl);

    const d = (await carol.client.get(`/api/issues/${key}`)).body.issue;
    expect(d.assignee.avatarUrl).toBe(avatarUrl);
    expect(d.reporter.avatarUrl).toBe(avatarUrl);
    expect(d.comments[0].author.avatarUrl).toBe(avatarUrl);
    expect(d.history[0].actor.avatarUrl).toBe(avatarUrl);
    expect(d.watchers.find((w) => w.id === bob.id).avatarUrl).toBe(avatarUrl);

    const list = (await carol.client.get('/api/issues?project=WEB')).body.issues;
    expect(list[0].assignee.avatarUrl).toBe(avatarUrl);
    const feed = (await carol.client.get('/api/activity?project=WEB')).body.items;
    expect(feed.every((i) => i.actor.avatarUrl === avatarUrl)).toBe(true);

    await bob.client.patch(`/api/issues/${key}`, { assigneeId: carol.id });
    const notes = (await carol.client.get('/api/notifications')).body.notifications;
    expect(notes[0].actor.avatarUrl).toBe(avatarUrl);
  });
});
