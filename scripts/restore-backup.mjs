#!/usr/bin/env node
// Load a full backup (Admin > Backups, or the daily copy) into a FRESH database through the app's adapters.
//
//   node scripts/restore-backup.mjs <backup.json | backup.json.gz> --sqlite <file.db>
//   node scripts/restore-backup.mjs <backup.json | backup.json.gz> --postgres <postgres://...>
//   node scripts/restore-backup.mjs <backup.json | backup.json.gz> --d1-sql <out.sql>
//   node scripts/restore-backup.mjs --github <owner/repo>[:path][@branch] --sqlite | --postgres | --d1-sql ...
//   add --force to load into a database that already has users (rows with the same ids then fail)
//
// --github downloads the copy the server commits there (server/lib/githubBackup.js), with GITHUB_TOKEN or the
// gh CLI's login. A commit of the repo's history can be restored by naming it as the branch (@<sha>).
// --d1-sql writes INSERT statements for a fresh Cloudflare D1 database: apply the migrations first
// (npx wrangler d1 migrations apply <db> --remote), then npx wrangler d1 execute <db> --remote --file <out.sql>.
//
// The script applies the migrations, then inserts every table in the backup's order. Users come back without
// passwords: they sign in with Google, or an admin sets a password or sends a new invite link. Attachments whose
// bytes are in the backup are kept in the database (storage 'db'); without bytes the attachment rows remain but
// their files are missing. Format: docs/backup-format.md. A one-project export cannot be restored with this script.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { sqliteAdapter, pgAdapter } from '../server/db/adapters.js';
import { migrate } from '../server/db/migrate.js';
import { BACKUP_FORMAT, BACKUP_VERSION, TABLES } from '../server/lib/backup.js';

const KNOWN = new Map(TABLES.map((t) => [t.name, t]));
const SAFE_NAME = /^[a-z_][a-z0-9_]*$/;

/** Parse a backup file's bytes (plain or gzip). */
export function readBackup(bytes) {
  const buf = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  return JSON.parse(Buffer.from(buf).toString('utf8'));
}

/**
 * Insert a parsed backup into `db` (an adapter from server/db/adapters.js; migrations must be applied).
 * Returns { rows: { table: n }, skipped: [table names not known to this version] }.
 */
export async function restoreBackup(db, backup, { force = false, log = () => {} } = {}) {
  if (!backup || backup.format !== BACKUP_FORMAT) throw new Error('Not a tracker backup file');
  if (backup.version !== BACKUP_VERSION)
    throw new Error(`Backup format version ${backup.version} is not supported (expected ${BACKUP_VERSION})`);
  if (backup.project) throw new Error('This is a one-project export; only a full backup can be restored');
  if (backup.complete !== true) throw new Error('The backup file is incomplete (it was cut off while it was written)');
  const existing = await db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM users');
  if (existing.n && !force) throw new Error('The target database already has users. Restore into a fresh database (or pass --force).');

  const out = { rows: {}, skipped: [] };
  const order = backup.tableOrder || Object.keys(backup.tables || {});
  for (const name of order) {
    const rows = backup.tables?.[name] || [];
    if (!KNOWN.has(name) || !SAFE_NAME.test(name)) {
      out.skipped.push(name);
      continue;
    }
    const parents = [];
    const stmts = [];
    for (const raw of rows) {
      const row = { ...raw };
      if (name === 'issues' && row.parent_id) {
        parents.push([row.id, row.parent_id]); // set after every issue is in (parents may come later)
        row.parent_id = null;
      }
      if (name === 'settings') stmts.push({ sql: 'DELETE FROM settings WHERE key = ?', params: [row.key] });
      const cols = Object.keys(row);
      if (cols.some((c) => !SAFE_NAME.test(c))) throw new Error(`Bad column name in ${name}`);
      stmts.push({
        sql: `INSERT INTO ${name} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        params: cols.map((c) => row[c]),
      });
    }
    for (const [id, parentId] of parents) stmts.push({ sql: 'UPDATE issues SET parent_id = ? WHERE id = ?', params: [parentId, id] });
    for (let i = 0; i < stmts.length; i += 200) await db.batch(stmts.slice(i, i + 200));
    if (name === 'file_chunks') {
      // bytes of R2/GCS files came along as chunks: keep them in the database
      const ids = [...new Set(rows.map((r) => r.file_id))];
      for (let i = 0; i < ids.length; i += 80) {
        const part = ids.slice(i, i + 80);
        await db.run(`UPDATE attachments SET storage = 'db' WHERE storage <> 'db' AND id IN (${part.map(() => '?').join(', ')})`, part);
      }
    }
    out.rows[name] = rows.length;
    log(`${name}: ${rows.length}`);
  }
  return out;
}

/** A SQL literal for D1 / SQLite. */
export function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** An adapter that records statements instead of running them (for --d1-sql). */
export function sqlRecorder() {
  const lines = [];
  const render = (sql, params = []) => {
    let i = 0;
    return `${sql.replace(/\?/g, () => sqlLiteral(params[i++]))};`;
  };
  return {
    lines,
    async get() {
      return { n: 0 };
    }, // a fresh database: no users yet
    async all() {
      return [];
    },
    async run(sql, params) {
      lines.push(render(sql, params));
      return { changes: 0 };
    },
    async batch(stmts) {
      for (const s of stmts) lines.push(render(s.sql, s.params));
      return [];
    },
  };
}

/** Download the backup the server commits to GitHub. spec: owner/repo[:path][@ref] */
export async function fetchGithubBackup(spec, { token = process.env.GITHUB_TOKEN, doFetch = fetch } = {}) {
  const m = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?::([^@]+))?(?:@(.+))?$/.exec(spec || '');
  if (!m) throw new Error('--github needs owner/repo[:path][@branch-or-commit]');
  const [, repo, path = 'tracker-backup.json', ref] = m;
  let auth = token;
  if (!auth) {
    try {
      auth = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
    } catch {
      /* no gh login */
    }
  }
  if (!auth) throw new Error('Set GITHUB_TOKEN (or log in with the gh CLI) to read the backup repository');
  const url = `https://api.github.com/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`;
  const res = await doFetch(url, {
    headers: { authorization: `Bearer ${auth}`, accept: 'application/vnd.github.raw', 'user-agent': 'opentrack-restore' },
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${repo}/${path}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function main(argv) {
  const at = (flag) => (argv.indexOf(flag) >= 0 ? argv[argv.indexOf(flag) + 1] : null);
  const flagValues = new Set(['--sqlite', '--postgres', '--d1-sql', '--github'].map(at).filter(Boolean));
  const file = argv.find((a) => !a.startsWith('--') && !flagValues.has(a));
  const github = at('--github');
  const sqlite = at('--sqlite');
  const postgres = at('--postgres');
  const d1Sql = at('--d1-sql');
  if ((!file && !github) || (!sqlite && !postgres && !d1Sql)) {
    console.error(
      'Usage: node scripts/restore-backup.mjs <backup.json[.gz]> | --github <owner/repo> then --sqlite <file.db> | --postgres <url> | --d1-sql <out.sql> [--force]',
    );
    process.exit(2);
  }
  const backup = readBackup(github ? await fetchGithubBackup(github) : readFileSync(file));
  if (d1Sql) {
    const rec = sqlRecorder();
    const r = await restoreBackup(rec, backup, { force: true, log: (m) => console.log(m) });
    writeFileSync(
      d1Sql,
      `-- Tracker backup from ${backup.createdAt} (schema ${backup.schema}). Load into a FRESH D1 database after its migrations.\nPRAGMA defer_foreign_keys = true;\n${rec.lines.join('\n')}\n`,
    );
    if (r.skipped.length) console.log(`skipped (unknown to this version): ${r.skipped.join(', ')}`);
    console.log(`Wrote ${rec.lines.length} statements to ${d1Sql}. Then: npx wrangler d1 execute <db> --remote --file ${d1Sql}`);
    return;
  }
  let db;
  let close = () => {};
  if (postgres) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: postgres, max: 2 });
    db = pgAdapter(pool);
    close = () => pool.end();
  } else {
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(sqlite);
    raw.exec('PRAGMA foreign_keys = ON');
    db = sqliteAdapter(raw);
    close = () => raw.close();
  }
  try {
    const applied = await migrate(db);
    if (applied.length) console.log(`migrations applied: ${applied.length}`);
    const r = await restoreBackup(db, backup, { force: argv.includes('--force'), log: (m) => console.log(m) });
    if (r.skipped.length) console.log(`skipped (unknown to this version): ${r.skipped.join(', ')}`);
    console.log(`Restored backup from ${backup.createdAt}.`);
  } finally {
    await close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
