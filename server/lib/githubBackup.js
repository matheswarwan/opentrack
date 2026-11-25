// Copy of the full backup in a GitHub repository (user, 2026-11-20): projects, issues, comments, history, settings
// and the rest of the workspace (docs/backup-format.md; never passwords, tokens, secrets or file bytes), written as
// one file, one row per line, so every run is a commit and the repo's history keeps each day's version.
// Restore after a crash: scripts/restore-backup.mjs --github <owner/repo> (SQLite, Postgres, or a SQL file for D1).
//
// Configure with env: GITHUB_BACKUP_REPO (owner/repo, ideally private), GITHUB_BACKUP_TOKEN (secret: a fine-grained
// token with Contents read and write on that one repository), optional GITHUB_BACKUP_BRANCH (default main) and
// GITHUB_BACKUP_PATH (default tracker-backup.json). Runs daily (job github_backup) and from Admin > Backups.
import { backupJson, startRecord, finishRecord, sumRows } from './backup.js';
import { toBase64 } from './files.js';

export const GITHUB_MAX_BYTES = 90 * 1024 * 1024; // the contents API takes files up to 100 MB

export function githubBackupConfig(env) {
  const repo = String(env.GITHUB_BACKUP_REPO || '').trim();
  if (!repo) return null;
  return {
    repo,
    valid: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo),
    hasToken: Boolean(env.GITHUB_BACKUP_TOKEN),
    branch: String(env.GITHUB_BACKUP_BRANCH || 'main'),
    path: String(env.GITHUB_BACKUP_PATH || 'tracker-backup.json').replace(/^\/+/, ''),
  };
}

const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

/** Write the backup to the repository. Returns { size, rows, commit, url, path }. */
export async function pushBackupToGitHub(env, { message, stats = { rows: {}, missingFiles: [] } } = {}) {
  const cfg = githubBackupConfig(env);
  if (!cfg) throw new Error('GITHUB_BACKUP_REPO is not set');
  if (!cfg.valid) throw new Error('GITHUB_BACKUP_REPO must look like owner/repo');
  if (!cfg.hasToken) throw new Error('GITHUB_BACKUP_TOKEN is not set');
  const doFetch = env.fetch || ((...a) => fetch(...a));
  const headers = {
    authorization: `Bearer ${env.GITHUB_BACKUP_TOKEN}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'opentrack-backup',
  };
  const parts = [];
  for await (const part of backupJson(env, { stats, lines: true })) parts.push(part);
  const bytes = new TextEncoder().encode(`${parts.join('')}\n`);
  if (bytes.length > GITHUB_MAX_BYTES)
    throw new Error(`The backup is ${(bytes.length / 1048576).toFixed(1)} MB, more than GitHub's file limit`);
  const url = `https://api.github.com/repos/${cfg.repo}/contents/${encPath(cfg.path)}`;
  // the current file's sha, when it exists (an update must name it)
  let sha;
  const cur = await doFetch(`${url}?ref=${encodeURIComponent(cfg.branch)}`, { headers });
  if (cur.status === 200) sha = (await cur.json()).sha;
  else if (cur.status === 401 || cur.status === 403)
    throw new Error(`GitHub refused the token (${cur.status}): it needs Contents read and write on ${cfg.repo}`);
  else if (cur.status !== 404) throw new Error(`GitHub answered ${cur.status} reading ${cfg.path}`);
  const res = await doFetch(url, {
    method: 'PUT',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      message: message || `Tracker backup ${new Date().toISOString()}`,
      content: toBase64(bytes),
      branch: cfg.branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json()).message || '';
    } catch {
      /* no body */
    }
    throw new Error(`GitHub answered ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  const out = await res.json();
  return { size: bytes.length, rows: sumRows(stats), commit: out.commit?.sha || null, url: out.commit?.html_url || null, path: cfg.path };
}

/** One recorded run (Admin > Backups lists it). actorId null for the daily job. */
export async function runGithubBackup(env, actorId) {
  const cfg = githubBackupConfig(env);
  const destination = cfg ? `github.com/${cfg.repo}/${cfg.path}` : 'GitHub';
  const id = await startRecord(env.db, 'github', actorId, destination);
  const stats = { rows: {}, missingFiles: [] };
  try {
    const r = await pushBackupToGitHub(env, { stats, message: `Tracker backup ${new Date().toISOString()}${actorId ? ' (manual)' : ''}` });
    await finishRecord(env.db, id, { size: r.size, rows: r.rows });
    return { ok: true, destination, ...r };
  } catch (e) {
    await finishRecord(env.db, id, { error: e });
    return { ok: false, destination, error: String(e?.message || e).slice(0, 300) };
  }
}

/** The daily job (server/lib/jobs.js). Nothing to do when GitHub is not configured. */
export async function runGithubBackupJob(ctx, counts) {
  if (!githubBackupConfig(ctx.env)) {
    counts.skipped = true;
    counts.summary = 'GitHub not configured (GITHUB_BACKUP_REPO, GITHUB_BACKUP_TOKEN): nothing sent';
    return { status: 'done' };
  }
  const r = await runGithubBackup(ctx.env, null);
  if (!r.ok) {
    counts.summary = `Failed: ${r.error}`;
    return { status: 'error', error: r.error };
  }
  Object.assign(counts, {
    destination: r.destination,
    size: r.size,
    rows: r.rows,
    commit: r.commit,
    summary: `Committed ${Math.max(1, Math.round(r.size / 1024))} KB (${r.rows} rows) to ${r.destination}`,
  });
  return { status: 'done' };
}
