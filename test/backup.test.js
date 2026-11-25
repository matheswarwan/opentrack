import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { withAdmin, addUser } from './helpers.js';
import { sqliteAdapter } from '../server/db/adapters.js';
import { migrate } from '../server/db/migrate.js';
import { fileStore } from '../server/lib/files.js';
import { runDueJobs } from '../server/lib/jobs.js';
import { TABLES, NEVER, BACKUP_FORMAT } from '../server/lib/backup.js';
import { restoreBackup, readBackup } from '../scripts/restore-backup.mjs';

let ctx, bob, carol, objects;

/** Session cookie of a test client, read back from a request it makes. */
async function cookieOf(who) {
  let cookie = '';
  const orig = ctx.app.request.bind(ctx.app);
  ctx.app.request = (path, init, env) => {
    cookie = init.headers.cookie;
    return orig(path, init, env);
  };
  await who.get('/api/me');
  ctx.app.request = orig;
  return cookie;
}

/** GET a streamed download: { status, text, chunks, headers }. */
async function download(who, path) {
  const res = await ctx.app.request(path, { headers: { cookie: await cookieOf(who) } }, ctx.env);
  if (!res.body) return { status: res.status, text: '', chunks: 0, headers: res.headers };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  let chunks = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks += 1;
    text += dec.decode(value, { stream: true });
  }
  return { status: res.status, text, chunks, headers: res.headers };
}

beforeEach(async () => {
  objects = new Map();
  ctx = await withAdmin({ PUBLIC_URL: 'https://tracker.example.com' });
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
  await bob.client.post('/api/projects', { key: 'web', name: 'Website' });
  const epic = (await bob.client.post('/api/issues', { projectKey: 'WEB', type: 'epic', title: 'Epic' })).body.issue;
  const story = (
    await bob.client.post('/api/issues', {
      projectKey: 'WEB',
      type: 'story',
      title: 'Story',
      parentKey: epic.key,
      labels: ['ui', 'api'],
      assigneeId: carol.id,
    })
  ).body.issue;
  await bob.client.post('/api/issues', { projectKey: 'WEB', type: 'subtask', title: 'Sub', parentKey: story.key });
  await bob.client.post(`/api/issues/${story.key}/comments`, { body: 'A comment' });
  await carol.client.post(`/api/issues/${story.key}/worklogs`, { hours: 1.5 });
  await bob.client.post(`/api/issues/${story.key}/links`, { targetKey: epic.key, type: 'relates' });
  const trashed = (await bob.client.post('/api/issues', { projectKey: 'WEB', title: 'In the Trash' })).body.issue;
  await bob.client.del(`/api/issues/${trashed.key}`);
  expect((await carol.client.post('/api/filters', { name: 'Mine', query: { assignee: 'me' } })).status).toBe(201);
  // secrets that must never be exported
  await bob.client.post('/api/me/tokens', { name: 'AI' });
  await carol.client.post('/api/feeds', { name: 'Feed', query: { project: 'WEB' } });
  await ctx.db.run('INSERT INTO integrations (key, config, updated_at) VALUES (?, ?, ?)', [
    'slack',
    JSON.stringify({ token: 'xoxb-SECRET-SLACK-TOKEN' }),
    new Date().toISOString(),
  ]);
  await ctx.db.run(
    `INSERT INTO feedback (id, user_id, kind, message, screenshot, status, created_at, updated_at) VALUES ('fb1', ?, 'bug', 'It broke', 'data:image/png;base64,SCREENSHOTBYTES', 'new', ?, ?)`,
    [carol.id, new Date().toISOString(), new Date().toISOString()],
  );
  // attachments: one in the database, one in R2
  const sid = (await ctx.db.get('SELECT id FROM issues WHERE key = ?', [story.key])).id;
  const t = new Date().toISOString();
  await ctx.db.run(
    `INSERT INTO attachments (id, issue_id, filename, content_type, size, storage, created_at) VALUES ('f-db', ?, 'a.txt', 'text/plain', 5, 'db', ?)`,
    [sid, t],
  );
  await fileStore(ctx.env, 'db').put('f-db', new TextEncoder().encode('hello'));
  await ctx.db.run(
    `INSERT INTO attachments (id, issue_id, filename, content_type, size, storage, created_at) VALUES ('f-r2', ?, 'b.bin', 'application/octet-stream', 3, 'r2', ?)`,
    [sid, t],
  );
  objects.set('attachments/f-r2', new Uint8Array([7, 8, 9]));
  ctx.env.FILES = {
    async put(k, v) {
      objects.set(k, v);
    },
    async get(k) {
      const v = objects.get(k);
      return v ? { arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) } : null;
    },
    async delete(k) {
      objects.delete(k);
    },
  };
});

describe('full backup download', () => {
  it('is admin only, streams valid JSON without secrets, and includes trashed issues', async () => {
    expect((await bob.client.get('/api/admin/backup')).status).toBe(403);
    const r = await download(ctx.admin, '/api/admin/backup');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toMatch(/attachment; filename="tracker-backup-\d{4}-\d{2}-\d{2}\.json"/);
    expect(r.chunks).toBeGreaterThan(10); // written piece by piece
    const b = JSON.parse(r.text);
    expect(b).toMatchObject({ format: BACKUP_FORMAT, version: 1, includesFiles: false, complete: true, project: null });

    // secrets: no such tables or columns, no secret values
    for (const t of NEVER.tables) expect(b.tables[t]).toBeUndefined();
    for (const c of NEVER.columns) expect(r.text).not.toContain(`"${c}"`);
    const hashes = await ctx.db.all('SELECT password_hash FROM users WHERE password_hash IS NOT NULL');
    expect(hashes.length).toBeGreaterThan(0);
    for (const h of hashes) expect(r.text).not.toContain(h.password_hash);
    for (const row of await ctx.db.all('SELECT token_hash FROM api_tokens UNION ALL SELECT token_hash FROM feeds'))
      expect(r.text).not.toContain(row.token_hash);
    for (const row of await ctx.db.all('SELECT id FROM sessions')) expect(r.text).not.toContain(row.id);
    expect(r.text).not.toContain('xoxb-SECRET-SLACK-TOKEN');
    expect(r.text).not.toContain('SCREENSHOTBYTES');
    expect(b.tables.feedback[0]).toMatchObject({ message: 'It broke' });
    expect(b.tables.users.map((u) => u.email).sort()).toEqual(['admin@example.com', 'bob@example.com', 'carol@example.com']);

    // content
    expect(b.tables.issues.find((i) => i.title === 'In the Trash').deleted_at).toBeTruthy();
    expect(b.tables.issues).toHaveLength(4);
    expect(b.tables.issue_labels).toHaveLength(2);
    expect(b.tables.attachments.map((a) => a.id).sort()).toEqual(['f-db', 'f-r2']);
    expect(b.tables.file_chunks).toBeUndefined();
    expect(b.tables.user_avatars).toBeUndefined();
    for (const t of [
      'projects',
      'project_members',
      'statuses',
      'comments',
      'issue_history',
      'issue_links',
      'watchers',
      'worklogs',
      'saved_filters',
      'audit_log',
    ])
      expect(b.tables[t].length).toBeGreaterThan(0);
    for (const [t, n] of Object.entries(b.rowCounts)) expect(b.tables[t]).toHaveLength(n);

    // recorded and audited
    const s = (await ctx.admin.get('/api/admin/backups')).body;
    expect(s.runs[0]).toMatchObject({ kind: 'download', status: 'ok', by: 'Ada Admin', size: r.text.length });
    expect(s.files).toMatchObject({ count: 2, bytes: 8 });
    expect(s.destination).toBe(null);
    expect(await ctx.db.get(`SELECT action FROM audit_log WHERE action = 'backup.downloaded'`)).toBeTruthy();
  });

  it('pages through every table (also composite keys) without losing or repeating rows', async () => {
    const saved = TABLES.map((t) => t.page);
    try {
      for (const t of TABLES) t.page = 2;
      const r = await download(ctx.admin, '/api/admin/backup?files=1');
      const b = JSON.parse(r.text);
      for (const t of ['issues', 'issue_labels', 'watchers', 'issue_history', 'project_members', 'statuses', 'file_chunks']) {
        const table = TABLES.find((x) => x.name === t);
        const n = t === 'file_chunks' ? 1 : (await ctx.db.get(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM ${t}`)).n;
        expect(b.tables[t].length).toBe(t === 'file_chunks' ? 2 : n); // file_chunks: 1 in the database + 1 from R2
        const ids = new Set(b.tables[t].map((row) => table.key.map((k) => row[k]).join('|')));
        expect(ids.size).toBe(b.tables[t].length);
        expect(n).toBeGreaterThan(0);
      }
    } finally {
      TABLES.forEach((t, i) => (t.page = saved[i]));
    }
  });

  it('adds file bytes when asked, within the size limit', async () => {
    const r = await download(ctx.admin, '/api/admin/backup?files=1');
    const b = JSON.parse(r.text);
    expect(b.includesFiles).toBe(true);
    const chunk = (id) => b.tables.file_chunks.find((c) => c.file_id === id);
    expect(Buffer.from(chunk('f-db').data, 'base64').toString()).toBe('hello');
    expect([...Buffer.from(chunk('f-r2').data, 'base64')]).toEqual([7, 8, 9]);
    expect(b.tables.user_avatars).toEqual([]);
    expect(b.missingFiles).toEqual([]);

    ctx.env.BACKUP_FILES_MAX = 4;
    const big = await ctx.admin.get('/api/admin/backup?files=1');
    expect(big.status).toBe(400);
    expect(big.body.error).toMatch(/Download without files/);
  });
});

describe('project export', () => {
  it('lets project admins export JSON and CSV of their project', async () => {
    expect((await carol.client.get('/api/projects/WEB/export.json')).status).toBe(403);
    const j = await download(bob.client, '/api/projects/WEB/export.json');
    expect(j.status).toBe(200);
    const b = JSON.parse(j.text);
    expect(b.project).toMatchObject({ key: 'WEB' });
    expect(b.tables.projects).toHaveLength(1);
    expect(b.tables.issues).toHaveLength(4);
    expect(Object.keys(b.tables)).not.toContain('saved_filters');
    expect(b.tables.users.map((u) => u.email).sort()).toEqual(['bob@example.com', 'carol@example.com']);
    expect(Object.keys(b.tables.users[0]).sort()).toEqual(['email', 'id', 'name', 'role', 'status']);

    const c = await download(bob.client, '/api/projects/WEB/export.csv');
    expect(c.status).toBe(200);
    expect(c.headers.get('content-type')).toContain('text/csv');
    const lines = c.text.trim().split('\n');
    expect(lines[0]).toBe(
      'Key,Type,Title,Status,Priority,Assignee,Reporter,Parent,Sprint,Story points,Estimate hours,Due,Labels,Created,Updated,Resolved,Description',
    );
    expect(lines).toHaveLength(4); // the trashed issue is left out
    expect(lines[2]).toMatch(/^WEB-2,story,Story,To Do,medium,Carol,Bob,WEB-1,/);
  });
});

describe('daily backup job', () => {
  const run = () => runDueJobs({ env: ctx.env, req: { url: 'https://tracker.example.com/api/x' } }, { force: 'backup' });

  it('does nothing without a destination', async () => {
    const r = await run();
    expect(r).toMatchObject({ ran: 'backup', status: 'done', result: { skipped: true } });
    expect((await ctx.admin.get('/api/admin/backups')).body.runs).toEqual([]);
  });

  it('posts the gzipped JSON to the webhook with the secret header', async () => {
    const calls = [];
    ctx.env.BACKUP_WEBHOOK_URL = 'https://backup.example.com/in?key=abc';
    ctx.env.BACKUP_WEBHOOK_SECRET = 'webhook-secret-123';
    ctx.env.fetch = async (url, init) => {
      const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
      calls.push({ url, headers: init.headers, bytes });
      return new Response('ok', { status: 200 });
    };
    const r = await run();
    expect(r).toMatchObject({ ran: 'backup', status: 'done' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://backup.example.com/in?key=abc');
    expect(calls[0].headers).toMatchObject({
      'x-backup-secret': 'webhook-secret-123',
      'content-encoding': 'gzip',
      'content-type': 'application/json',
    });
    const b = readBackup(calls[0].bytes);
    expect(b).toMatchObject({ format: BACKUP_FORMAT, complete: true, includesFiles: false });
    expect(gunzipSync(calls[0].bytes).length).toBeGreaterThan(calls[0].bytes.length);
    const s = (await ctx.admin.get('/api/admin/backups')).body;
    expect(s.destination).toEqual({ type: 'webhook', label: 'Webhook backup.example.com' });
    expect(s.runs[0]).toMatchObject({
      kind: 'webhook',
      status: 'ok',
      size: calls[0].bytes.length,
      destination: 'Webhook backup.example.com',
    });
    expect(JSON.stringify(s)).not.toContain('key=abc');
    expect(s.job).toMatchObject({ name: 'backup', status: 'done' });
    expect(s.job.result.summary).toMatch(/^Sent .* to Webhook backup\.example\.com$/);
  });

  it('records a failure so admins can see it', async () => {
    ctx.env.BACKUP_WEBHOOK_URL = 'https://backup.example.com/in';
    ctx.env.fetch = async (url, init) => {
      await new Response(init.body).arrayBuffer();
      return new Response('nope', { status: 503 });
    };
    const r = await run();
    expect(r).toMatchObject({ ran: 'backup', status: 'error', error: 'The webhook answered 503' });
    const s = (await ctx.admin.get('/api/admin/backups')).body;
    expect(s.runs[0]).toMatchObject({ status: 'error', error: 'The webhook answered 503' });
    expect(s.job).toMatchObject({ status: 'error', error: 'The webhook answered 503' });
  });
});

describe('restore script', () => {
  it('loads a backup into a fresh SQLite database', async () => {
    const r = await download(ctx.admin, '/api/admin/backup?files=1');
    const backup = readBackup(Buffer.from(r.text));
    const raw = new DatabaseSync(':memory:');
    raw.exec('PRAGMA foreign_keys = ON');
    const db = sqliteAdapter(raw);
    await migrate(db);
    const out = await restoreBackup(db, backup);
    expect(out.skipped).toEqual([]);
    for (const t of [
      'users',
      'projects',
      'project_members',
      'statuses',
      'issues',
      'issue_labels',
      'comments',
      'issue_history',
      'issue_links',
      'watchers',
      'worklogs',
      'attachments',
      'saved_filters',
      'audit_log',
    ]) {
      const a = (await ctx.db.get(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM ${t}`)).n;
      const b = (await db.get(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM ${t}`)).n;
      expect([t, b]).toEqual([t, a]);
    }
    const q = 'SELECT key, title, parent_id, status_id, assignee_id, deleted_at, deleted_by FROM issues ORDER BY key';
    expect(await db.all(q)).toEqual(await ctx.db.all(q));
    expect((await db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM users WHERE password_hash IS NOT NULL')).n).toBe(0);
    // file bytes: the R2 one now lives in the database
    expect(await db.get(`SELECT storage FROM attachments WHERE id = 'f-r2'`)).toEqual({ storage: 'db' });
    expect(new TextDecoder().decode(await fileStore({ db }, 'db').get('f-db'))).toBe('hello');
    expect([...(await fileStore({ db }, 'db').get('f-r2'))]).toEqual([7, 8, 9]);

    // refuses a database that already has users, an incomplete file and a project export
    await expect(restoreBackup(db, backup)).rejects.toThrow(/already has users/);
    const fresh = sqliteAdapter(new DatabaseSync(':memory:'));
    await migrate(fresh);
    await expect(restoreBackup(fresh, { ...backup, complete: undefined })).rejects.toThrow(/incomplete/);
    const proj = JSON.parse((await download(bob.client, '/api/projects/WEB/export.json')).text);
    await expect(restoreBackup(fresh, proj)).rejects.toThrow(/one-project export/);
  });
});
