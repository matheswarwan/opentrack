// Comment reactions and threaded replies (migration 0020, server/lib/comments.js, server/routes/issues.js).
import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser } from './helpers.js';

let ctx, bob, carol, dave, erin, gina, vic;
// CLI: private, Bob's; Carol, Dave, Erin members; Gina a guest who may comment; Vic a workspace viewer.
beforeEach(async () => {
  ctx = await withAdmin();
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
  dave = await addUser(ctx, { email: 'dave@example.com', name: 'Dave' });
  erin = await addUser(ctx, { email: 'erin@example.com', name: 'Erin' });
  gina = await addUser(ctx, { email: 'gina@client.example', name: 'Gina Guest', role: 'guest' });
  vic = await addUser(ctx, { email: 'vic@example.com', name: 'Vic Viewer', role: 'viewer' });
  await bob.client.post('/api/projects', { key: 'CLI', name: 'Client portal', visibility: 'private' });
  for (const [who, role] of [
    [carol, 'member'],
    [dave, 'member'],
    [erin, 'member'],
    [gina, 'guest-comment'],
    [vic, 'viewer'],
  ]) {
    const r = await bob.client.put(`/api/projects/CLI/members/${who.id}`, { role });
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  }
  await bob.client.post('/api/issues', { projectKey: 'CLI', title: 'Portal task' });
});

const comment = async (who, body, extra = {}) => {
  const r = await who.client.post('/api/issues/CLI-1/comments', { body, ...extra });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.comment;
};
const detail = async (who) => (await who.client.get('/api/issues/CLI-1')).body.issue;
const notes = async (who) => (await who.client.get('/api/notifications')).body.notifications;

describe('reactions', () => {
  it('toggles per person and returns counts with who reacted', async () => {
    const c = await comment(carol, 'Ready for review');
    let r = await bob.client.post(`/api/comments/${c.id}/reactions/thumbsup`);
    expect(r.status).toBe(200);
    expect(r.body.reactions).toEqual([{ reaction: 'thumbsup', count: 1, users: [{ id: bob.id, name: 'Bob' }], mine: true }]);
    await bob.client.post(`/api/comments/${c.id}/reactions/thumbsup`); // twice: still one
    await dave.client.post(`/api/comments/${c.id}/reactions/thumbsup`);
    await dave.client.post(`/api/comments/${c.id}/reactions/party`);
    const seen = (await detail(carol)).comments.find((x) => x.id === c.id).reactions;
    expect(seen.map((x) => [x.reaction, x.count, x.users.map((u) => u.name).join(', '), x.mine])).toEqual([
      ['thumbsup', 2, 'Bob, Dave', false],
      ['party', 1, 'Dave', false],
    ]);
    r = await bob.client.del(`/api/comments/${c.id}/reactions/thumbsup`);
    expect(r.body.reactions.map((x) => [x.reaction, x.count, x.mine])).toEqual([
      ['thumbsup', 1, false],
      ['party', 1, false],
    ]);
  });

  it('refuses unknown reactions, read-only people and sends no notifications', async () => {
    const c = await comment(carol, 'Hello');
    const before = (await notes(carol)).length;
    expect((await bob.client.post(`/api/comments/${c.id}/reactions/rocket`)).status).toBe(400);
    expect((await vic.client.post(`/api/comments/${c.id}/reactions/heart`)).status).toBe(403);
    expect((await bob.client.post(`/api/comments/${c.id}/reactions/heart`)).status).toBe(200);
    expect((await notes(carol)).length).toBe(before);
  });

  it('guests cannot see or react to internal notes', async () => {
    const note = await comment(bob, 'Margin is thin', { internal: true });
    const open = await comment(bob, 'Shipping Friday');
    await dave.client.post(`/api/comments/${note.id}/reactions/eyes`);
    expect((await gina.client.post(`/api/comments/${note.id}/reactions/eyes`)).status).toBe(404);
    expect((await gina.client.post(`/api/comments/${open.id}/reactions/heart`)).status).toBe(200);
    const g = await detail(gina);
    expect(g.comments.map((x) => x.id)).toEqual([open.id]);
    expect(g.comments[0].reactions).toMatchObject([{ reaction: 'heart', count: 1, mine: true }]);
  });

  it('a project outsider gets 404', async () => {
    const out = await addUser(ctx, { email: 'out@example.com', name: 'Outsider' });
    const c = await comment(carol, 'Private');
    expect((await out.client.post(`/api/comments/${c.id}/reactions/heart`)).status).toBe(404);
  });
});

describe('threaded replies', () => {
  it('nests one level: a reply to a reply attaches to the top comment', async () => {
    const top = await comment(carol, 'Top');
    const r1 = await comment(dave, 'First reply', { parentId: top.id });
    expect(r1.parentId).toBe(top.id);
    const r2 = await comment(erin, 'Reply to the reply', { parentId: r1.id });
    expect(r2.parentId).toBe(top.id);
    const list = (await detail(bob)).comments;
    expect(list.map((x) => [x.body, x.parentId])).toEqual([
      ['Top', null],
      ['First reply', top.id],
      ['Reply to the reply', top.id],
    ]);
  });

  it('refuses a parent from another issue', async () => {
    await bob.client.post('/api/issues', { projectKey: 'CLI', title: 'Other task' });
    const other = (await bob.client.post('/api/issues/CLI-2/comments', { body: 'Elsewhere' })).body.comment;
    expect((await carol.client.post('/api/issues/CLI-1/comments', { body: 'x', parentId: other.id })).status).toBe(404);
  });

  it('notifies the top author and earlier repliers once each, besides watchers and mentions', async () => {
    const top = await comment(carol, 'Can someone check the login page?');
    await comment(dave, 'Looking now', { parentId: top.id });
    let c = await notes(carol);
    expect(c.filter((n) => n.type === 'reply').map((n) => n.message)).toEqual(['Dave replied to your comment on CLI-1']);
    expect(c.filter((n) => n.type === 'comment')).toHaveLength(0); // Carol watches, but gets the reply only
    expect((await notes(bob)).filter((n) => n.message.startsWith('Dave')).map((n) => n.type)).toEqual(['comment']); // a watcher

    await comment(erin, `Fixed, @[Carol](user:${carol.id}) please retest`, { parentId: top.id });
    c = (await notes(carol)).filter((n) => n.message.startsWith('Erin'));
    expect(c.map((n) => n.type)).toEqual(['mentioned']); // the mention wins, no duplicate
    const d = (await notes(dave)).filter((n) => n.message.startsWith('Erin'));
    expect(d.map((n) => [n.type, n.message])).toEqual([['reply', 'Erin replied in a thread you are in on CLI-1']]);
    expect((await notes(bob)).filter((n) => n.message.startsWith('Erin')).map((n) => n.type)).toEqual(['comment']);
    expect((await notes(erin)).filter((n) => n.message.startsWith('Erin'))).toHaveLength(0); // never yourself
  });

  it('a reply to an internal note is internal, and guests never see it or its notifications', async () => {
    const top = await comment(gina, 'Question from the client'); // Gina takes part in the public thread
    await comment(dave, 'Answer', { parentId: top.id });
    const note = await comment(bob, 'Internal: budget', { internal: true });
    const reply = await comment(carol, 'Agreed', { parentId: note.id, internal: false });
    expect(reply.internal).toBe(true);
    expect((await gina.client.post('/api/issues/CLI-1/comments', { body: 'x', parentId: note.id })).status).toBe(404);
    const g = await detail(gina);
    expect(g.comments.map((x) => x.body)).toEqual(['Question from the client', 'Answer']);
    expect((await notes(gina)).map((n) => n.message)).toEqual(['Dave replied to your comment on CLI-1']);
    // making a top comment internal makes its replies internal too
    const own = await comment(bob, 'Public now');
    await comment(dave, 'Reply', { parentId: own.id });
    await bob.client.patch(`/api/comments/${own.id}`, { body: 'Public now', internal: true });
    expect((await detail(gina)).comments.map((x) => x.body)).toEqual(['Question from the client', 'Answer']);
    // a reply in an internal thread cannot be made public
    await carol.client.patch(`/api/comments/${reply.id}`, { body: 'Agreed', internal: false });
    expect((await detail(bob)).comments.find((x) => x.id === reply.id).internal).toBe(true);
  });

  it('deleting a top comment with replies leaves a placeholder; removing the last reply removes it', async () => {
    const top = await comment(carol, 'Top');
    await carol.client.post(`/api/comments/${top.id}/reactions/heart`);
    const r1 = await comment(dave, 'One', { parentId: top.id });
    const r2 = await comment(erin, 'Two', { parentId: top.id });
    const del = await carol.client.del(`/api/comments/${top.id}`);
    expect(del.body).toMatchObject({ ok: true, placeholder: true });
    let list = (await detail(bob)).comments;
    expect(list[0]).toMatchObject({ id: top.id, deleted: true, body: '', author: null, reactions: [] });
    expect(list.slice(1).map((x) => x.body)).toEqual(['One', 'Two']);
    expect((await carol.client.patch(`/api/comments/${top.id}`, { body: 'back' })).status).toBe(404);
    expect((await bob.client.post(`/api/comments/${top.id}/reactions/heart`)).status).toBe(404);
    // replying to the thread still works
    await comment(bob, 'Three', { parentId: top.id });
    await dave.client.del(`/api/comments/${r1.id}`);
    await erin.client.del(`/api/comments/${r2.id}`);
    list = (await detail(bob)).comments;
    expect(list.map((x) => x.body)).toEqual(['', 'Three']);
    const three = list[1];
    await bob.client.del(`/api/comments/${three.id}`);
    expect((await detail(bob)).comments).toEqual([]);
  });

  it('a top comment without replies is removed outright', async () => {
    const top = await comment(carol, 'Alone');
    expect((await carol.client.del(`/api/comments/${top.id}`)).body).toEqual({ ok: true });
    expect((await detail(bob)).comments).toEqual([]);
  });

  it('the activity feed shows replies as comments and leaves out placeholders and internal ones for guests', async () => {
    const top = await comment(carol, 'Top');
    await comment(dave, 'A reply', { parentId: top.id });
    const note = await comment(bob, 'Internal', { internal: true });
    await comment(erin, 'Internal reply', { parentId: note.id });
    await carol.client.del(`/api/comments/${top.id}`);
    const items = (await bob.client.get('/api/activity?project=CLI')).body.items.filter((a) => a.kind === 'comment');
    expect(items.map((a) => [a.body, a.reply]).sort((x, y) => x[0].localeCompare(y[0]))).toEqual([
      ['A reply', true],
      ['Internal', false],
      ['Internal reply', true],
    ]);
    const g = (await gina.client.get('/api/activity?project=CLI')).body.items.filter((a) => a.kind === 'comment');
    expect(g.map((a) => a.body)).toEqual(['A reply']);
  });
});
