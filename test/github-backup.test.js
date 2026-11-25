import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { withAdmin } from './helpers.js';
import { sqliteAdapter } from '../server/db/adapters.js';
import { migrate } from '../server/db/migrate.js';
import { runDueJobs } from '../server/lib/jobs.js';
import { githubBackupConfig } from '../server/lib/githubBackup.js';
import { readBackup, restoreBackup, sqlRecorder, sqlLiteral, fetchGithubBackup } from '../scripts/restore-backup.mjs';

// A fake GitHub contents API: one file per path, sha changes on every write.
function fakeGitHub({ status } = {}) {
  const files = {};
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers, body: init.body });
    if (status) return new Response(JSON.stringify({ message: 'Bad credentials' }), { status });
    const path = decodeURIComponent(new URL(url).pathname.split('/contents/')[1]);
    if ((init.method || 'GET') === 'GET') {
      if (!files[path]) return new Response('{}', { status: 404 });
      if (init.headers?.accept === 'application/vnd.github.raw') return new Response(files[path].text);
      return Response.json({ sha: files[path].sha });
    }
    const b = JSON.parse(init.body);
    if (files[path] && b.sha !== files[path].sha) return Response.json({ message: 'sha mismatch' }, { status: 409 });
    const sha = `sha${calls.length}`;
    files[path] = { sha, text: Buffer.from(b.content, 'base64').toString('utf8'), message: b.message, branch: b.branch };
    return Response.json(
      { commit: { sha: `c-${sha}`, html_url: `https://github.com/o/r/commit/c-${sha}` } },
      { status: files[path] ? 200 : 201 },
    );
  };
  return { files, calls, fetch };
}

describe('backup to GitHub', () => {
  it('commits the full backup (no secrets), updates it with the sha, and runs as a job', async () => {
    const gh = fakeGitHub();
    const ctx = await withAdmin({ GITHUB_BACKUP_REPO: 'acme/tracker-backups', GITHUB_BACKUP_TOKEN: 'ghp_test', fetch: gh.fetch });
    await ctx.admin.post('/api/projects', { key: 'WEB', name: 'Website' });
    await ctx.admin.post('/api/issues', { projectKey: 'WEB', title: 'First issue' });
    const s = (await ctx.admin.get('/api/admin/backups')).body;
    expect(s.github).toMatchObject({ repo: 'acme/tracker-backups', branch: 'main', path: 'tracker-backup.json', ready: true });
    const r = await ctx.admin.post('/api/admin/backups/github');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      commit: expect.stringMatching(/^c-/),
      destination: 'github.com/acme/tracker-backups/tracker-backup.json',
    });
    const put = gh.calls.find((c) => c.method === 'PUT');
    expect(put.url).toBe('https://api.github.com/repos/acme/tracker-backups/contents/tracker-backup.json');
    expect(put.headers.authorization).toBe('Bearer ghp_test');
    const file = gh.files['tracker-backup.json'];
    expect(file.branch).toBe('main');
    const backup = readBackup(Buffer.from(file.text));
    expect(backup.complete).toBe(true);
    expect(backup.tables.issues.map((i) => i.title)).toEqual(['First issue']);
    expect(file.text).not.toMatch(/password_hash|ghp_test|token_hash/);
    expect(file.text.split('\n').length).toBeGreaterThan(10); // one row per line
    // the job writes again, naming the current sha
    const job = await runDueJobs({ env: ctx.env, req: { url: 'https://t.example/api/x' } }, { force: 'github_backup' });
    expect(job.status).toBe('done');
    expect(gh.calls.filter((c) => c.method === 'PUT').length).toBe(2);
    expect(JSON.parse(gh.calls.filter((c) => c.method === 'PUT')[1].body).sha).toMatch(/^sha/);
    const runs = (await ctx.admin.get('/api/admin/backups')).body.runs;
    expect(runs.filter((x) => x.kind === 'github').map((x) => x.status)).toEqual(['ok', 'ok']);
    expect((await ctx.admin.get('/api/admin/audit?action=backup.github')).body.entries.length).toBe(1);

    // and the restore script reads it back from GitHub
    const bytes = await fetchGithubBackup('acme/tracker-backups', { token: 't', doFetch: gh.fetch });
    expect(readBackup(Buffer.from(bytes)).tables.projects.map((p) => p.key)).toEqual(['WEB']);
  });

  it('reports a refused token and does nothing when not configured', async () => {
    const gh = fakeGitHub({ status: 401 });
    const ctx = await withAdmin({ GITHUB_BACKUP_REPO: 'acme/b', GITHUB_BACKUP_TOKEN: 'bad', fetch: gh.fetch });
    const r = await ctx.admin.post('/api/admin/backups/github');
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/refused the token/);
    expect(githubBackupConfig({})).toBe(null);
    expect(githubBackupConfig({ GITHUB_BACKUP_REPO: 'not a repo' }).valid).toBe(false);
    const plain = await withAdmin();
    expect((await plain.admin.post('/api/admin/backups/github')).status).toBe(400);
    const job = await runDueJobs({ env: plain.env, req: { url: 'https://t.example/api/x' } }, { force: 'github_backup' });
    expect(job.result.skipped).toBe(true);
  });
});

describe('restore as SQL for a fresh D1', () => {
  it('writes statements that rebuild the workspace', async () => {
    const gh = fakeGitHub();
    const ctx = await withAdmin({ GITHUB_BACKUP_REPO: 'acme/b', GITHUB_BACKUP_TOKEN: 't', fetch: gh.fetch });
    await ctx.admin.post('/api/projects', { key: 'WEB', name: "O'Brien site" });
    await ctx.admin.post('/api/issues', { projectKey: 'WEB', title: 'Parent' });
    await ctx.admin.post('/api/issues', { projectKey: 'WEB', title: 'Sub', type: 'subtask', parentKey: 'WEB-1' });
    await ctx.admin.post('/api/admin/backups/github');
    const backup = readBackup(Buffer.from(gh.files['tracker-backup.json'].text));
    const rec = sqlRecorder();
    await restoreBackup(rec, backup, { force: true });
    expect(sqlLiteral("it's")).toBe("'it''s'");
    expect(sqlLiteral(null)).toBe('NULL');
    // run the SQL in a fresh migrated SQLite, as D1 would
    const raw = new DatabaseSync(':memory:');
    raw.exec('PRAGMA foreign_keys = ON');
    const db = sqliteAdapter(raw);
    await migrate(db);
    raw.exec(`PRAGMA defer_foreign_keys = true; BEGIN; ${rec.lines.join('\n')} COMMIT;`);
    for (const t of ['users', 'projects', 'issues', 'statuses']) {
      // audit_log: the backup.github row comes after the backup
      expect([t, (await db.get(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM ${t}`)).n]).toEqual([
        t,
        (await ctx.db.get(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM ${t}`)).n,
      ]);
    }
    expect((await db.get(`SELECT name FROM projects WHERE key = 'WEB'`)).name).toBe("O'Brien site");
    const q = 'SELECT key, parent_id FROM issues ORDER BY key';
    expect(await db.all(q)).toEqual(await ctx.db.all(q));
  });
});
