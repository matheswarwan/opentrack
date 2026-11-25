import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser } from './helpers.js';

let ctx, bob, carol, dave, issueKey;
beforeEach(async () => {
  ctx = await withAdmin();
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
  dave = await addUser(ctx, { email: 'dave@example.com', name: 'Dave', role: 'viewer' });
  await bob.client.post('/api/projects', { key: 'web', name: 'Website' });
  issueKey = (await bob.client.post('/api/issues', { projectKey: 'WEB', title: 'Has files' })).body.issue.key;
});

/** Session cookie of a test client, read back from a request it makes. */
async function cookieOf(who) {
  let cookie = '';
  const orig = ctx.app.request.bind(ctx.app);
  ctx.app.request = (path, init, env) => {
    cookie = init.headers.cookie;
    return orig(path, init, env);
  };
  await who.client.get('/api/me');
  ctx.app.request = orig;
  return cookie;
}

async function upload(who, key, bytes, filename, type, headers = {}) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), filename);
  const res = await ctx.app.request(
    `/api/issues/${key}/attachments`,
    {
      method: 'POST',
      headers: { cookie: await cookieOf(who), 'x-requested-with': 'opentrack', ...headers },
      body: form,
    },
    ctx.env,
  );
  return { status: res.status, body: await res.json() };
}

async function download(who, url, headers = {}) {
  const h = who ? { cookie: await cookieOf(who) } : {};
  const res = await ctx.app.request(url, { headers: { ...h, ...headers } }, ctx.env);
  return { status: res.status, headers: res.headers, bytes: new Uint8Array(await res.arrayBuffer()) };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function bigBytes(n) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + (i >> 8)) & 0xff;
  return b;
}

describe('attachments', () => {
  it('uploads, lists in the issue, downloads identical bytes across chunks', async () => {
    const big = bigBytes(2.5 * 1024 * 1024);
    const r = await upload(bob, issueKey, big, 'dump.bin', 'application/octet-stream');
    expect(r.status).toBe(201);
    expect(r.body.attachment).toMatchObject({ filename: 'dump.bin', size: big.length, mine: true, uploadedBy: { name: 'Bob' } });
    const chunks = await ctx.db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM file_chunks WHERE file_id = ?', [r.body.attachment.id]);
    expect(chunks.n).toBeGreaterThan(2);

    const d = await bob.client.get(`/api/issues/${issueKey}`);
    expect(d.body.issue.attachments).toHaveLength(1);
    expect(d.body.issue.attachments[0]).toMatchObject({
      id: r.body.attachment.id,
      url: `/api/attachments/${r.body.attachment.id}`,
      contentType: 'application/octet-stream',
    });
    const h = d.body.issue.history.find((x) => x.field === 'attachment');
    expect(h).toMatchObject({ from: null, to: 'dump.bin' });

    const got = await download(carol, r.body.attachment.url);
    expect(got.status).toBe(200);
    expect(got.bytes.length).toBe(big.length);
    expect(Buffer.from(got.bytes).equals(Buffer.from(big))).toBe(true);
    expect(got.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it('accepts a raw body with ?filename=', async () => {
    const res = await ctx.app.request(
      `/api/issues/${issueKey}/attachments?filename=notes.txt`,
      {
        method: 'POST',
        headers: { cookie: await cookieOf(bob), 'x-requested-with': 'opentrack', 'content-type': 'text/plain; charset=utf-8' },
        body: 'hello',
      },
      ctx.env,
    );
    expect(res.status).toBe(201);
    const a = (await res.json()).attachment;
    expect(a).toMatchObject({ filename: 'notes.txt', contentType: 'text/plain', size: 5 });
  });

  it('serves images inline and risky files as octet-stream downloads', async () => {
    const png = (await upload(bob, issueKey, PNG, 'shot.png', 'image/png')).body.attachment;
    const r = await download(bob, png.url);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('content-disposition')).toBe('inline; filename="shot.png"; filename*=UTF-8\'\'shot.png');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toBe("default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    expect(r.headers.get('cache-control')).toBe('private, max-age=3600');

    const html = (await upload(bob, issueKey, new TextEncoder().encode('<script>alert(1)</script>'), 'evil.html', 'text/html')).body
      .attachment;
    const h = await download(bob, html.url);
    expect(h.headers.get('content-type')).toBe('application/octet-stream');
    expect(h.headers.get('content-disposition')).toMatch(/^attachment;/);

    // an SVG claiming to be a PNG by type is still a download
    const svg = (await upload(bob, issueKey, new TextEncoder().encode('<svg/>'), 'pic.svg', 'image/png')).body.attachment;
    const s = await download(bob, svg.url);
    expect(s.headers.get('content-type')).toBe('application/octet-stream');
    expect(s.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it('enforces size and count limits', async () => {
    const tooBig = await upload(bob, issueKey, new Uint8Array(10 * 1024 * 1024 + 1), 'big.bin', 'application/octet-stream');
    expect(tooBig.status).toBe(413);
    expect((await upload(bob, issueKey, new Uint8Array(0), 'empty.txt', 'text/plain')).status).toBe(400);
    const issue = await ctx.db.get('SELECT id FROM issues WHERE key = ?', [issueKey]);
    const stmts = [];
    for (let i = 0; i < 50; i++) {
      stmts.push({
        sql: 'INSERT INTO attachments (id, issue_id, filename, content_type, size, storage, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        params: [`f${i}`, issue.id, `f${i}.txt`, 'text/plain', 1, 'db', new Date().toISOString()],
      });
    }
    await ctx.db.batch(stmts);
    const r = await upload(bob, issueKey, PNG, 'one-more.png', 'image/png');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/at most 50/);
  });

  it('checks permissions for upload, download and delete', async () => {
    const a = (await upload(bob, issueKey, PNG, 'shot.png', 'image/png')).body.attachment;
    // a viewer can download but not upload
    expect((await download(dave, a.url)).status).toBe(200);
    expect((await upload(dave, issueKey, PNG, 'x.png', 'image/png')).status).toBe(403);
    // another member can upload but not delete someone else's file
    const c = (await upload(carol, issueKey, PNG, 'carol.png', 'image/png')).body.attachment;
    expect((await carol.client.del(`/api/attachments/${a.id}`)).status).toBe(403);
    // the uploader can delete their own
    expect((await carol.client.del(`/api/attachments/${c.id}`)).status).toBe(200);
    // private project: non-members get 404
    await bob.client.patch('/api/projects/WEB', { visibility: 'private' });
    expect((await download(carol, a.url)).status).toBe(404);
    expect((await carol.client.del(`/api/attachments/${a.id}`)).status).toBe(404);
    expect((await upload(carol, issueKey, PNG, 'x.png', 'image/png')).status).toBe(404);
    // the project admin (lead) deletes anyone's file; history records it
    const b2 = (await upload(bob, issueKey, PNG, 'b2.png', 'image/png')).body.attachment;
    await ctx.db.run('UPDATE attachments SET uploaded_by = ? WHERE id = ?', [carol.id, b2.id]);
    expect((await bob.client.del(`/api/attachments/${b2.id}`)).status).toBe(200);
    const d = await bob.client.get(`/api/issues/${issueKey}`);
    expect(d.body.issue.attachments.map((x) => x.id)).toEqual([a.id]);
    expect(
      d.body.issue.history
        .filter((x) => x.field === 'attachment' && x.to === null)
        .map((x) => x.from)
        .sort(),
    ).toEqual(['b2.png', 'carol.png']);
    expect(await ctx.db.get('SELECT file_id FROM file_chunks WHERE file_id = ?', [c.id])).toBeNull();
  });

  it('respects API token project scope', async () => {
    const other = await bob.client.post('/api/projects', { key: 'ops', name: 'Ops' });
    const web = await bob.client.get('/api/projects/WEB');
    const a = (await upload(bob, issueKey, PNG, 'shot.png', 'image/png')).body.attachment;
    const opsIssue = (await bob.client.post('/api/issues', { projectKey: 'OPS', title: 'ops' })).body.issue.key;
    const b = (await upload(bob, opsIssue, PNG, 'ops.png', 'image/png')).body.attachment;
    const token = (await bob.client.post('/api/me/tokens', { name: 'Ops only', projectIds: [other.body.project.id] })).body.token;
    expect(web.status).toBe(200);
    const auth = { authorization: `Bearer ${token}` };
    expect((await download(null, a.url, auth)).status).toBe(404);
    expect((await download(null, b.url, auth)).status).toBe(200);
    const res = await ctx.app.request(
      `/api/issues/${issueKey}/attachments?filename=x.txt`,
      { method: 'POST', headers: { ...auth, 'content-type': 'text/plain' }, body: 'x' },
      ctx.env,
    );
    expect(res.status).toBe(404);
  });

  it('removes files when the issue is deleted for good (Trash, then Delete forever)', async () => {
    const a = (await upload(bob, issueKey, bigBytes(1024 * 1024), 'a.bin', 'application/octet-stream')).body.attachment;
    const sub = (await bob.client.post('/api/issues', { projectKey: 'WEB', type: 'subtask', parentKey: issueKey, title: 'sub' })).body.issue
      .key;
    await upload(bob, sub, PNG, 's.png', 'image/png');
    expect((await ctx.db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM file_chunks')).n).toBeGreaterThan(1);
    expect((await bob.client.del(`/api/issues/${issueKey}`)).status).toBe(200);
    expect((await download(bob, a.url)).status).toBe(404); // in the Trash: the file is kept but not served
    expect((await ctx.db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM file_chunks')).n).toBeGreaterThan(1);
    expect((await bob.client.del(`/api/trash/${issueKey}`)).status).toBe(200);
    expect((await ctx.db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM file_chunks')).n).toBe(0);
    expect((await ctx.db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM attachments')).n).toBe(0);
    expect((await download(bob, a.url)).status).toBe(404);
  });

  it('deletes R2 objects with the issue', async () => {
    const objects = new Map();
    ctx.env.FILES = {
      async put(k, v) {
        objects.set(k, new Uint8Array(v));
      },
      async get(k) {
        const v = objects.get(k);
        return v ? { arrayBuffer: async () => v.buffer } : null;
      },
      async delete(k) {
        objects.delete(k);
      },
    };
    const a = (await upload(bob, issueKey, PNG, 'r2.png', 'image/png')).body.attachment;
    expect(objects.has(`attachments/${a.id}`)).toBe(true);
    expect((await download(bob, a.url)).bytes).toEqual(PNG);
    await bob.client.del(`/api/issues/${issueKey}`);
    expect(objects.size).toBe(1); // in the Trash
    await bob.client.del(`/api/trash/${issueKey}`);
    expect(objects.size).toBe(0);
  });
});
