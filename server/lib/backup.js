// Full JSON backups (format: docs/backup-format.md) and the daily automatic copy.
//
// The export is a stream: the JSON is written table by table, page by page (keyset pagination on each table's
// primary key), so it never holds the workspace in memory and every query stays small. On D1's free plan a request
// may make about 50 queries; a page is up to a few hundred rows, so a small workspace fits easily, but a very large
// one could run out of queries part way. The last key of a finished file is "complete": true, so a cut-off file is
// easy to spot.
//
// Never included: password hashes, two-factor secrets and recovery codes (users.totp_*, recovery_codes, login_challenges), sessions, invites, API/OAuth tokens and codes, feed tokens, the Slack token and
// other integration settings (table integrations, incl. the Slack signing secret), webhooks and their delivery log (signing
// secrets; the URLs can hold tokens), login failures, error logs, jobs state, notifications, feedback
// screenshots, AI provider keys (env only) and the AI error log (ai_errors). Attachments are always listed (metadata); their bytes (file_chunks, and R2/GCS objects read back) and
// profile photos are added only when asked (includeFiles) and the files total at most BACKUP_FILES_MAX bytes.
import { uuid } from './crypto.js';
import { fileStore, toBase64, gcsUpload } from './files.js';
import { getSettings } from './settings.js';

export const BACKUP_FORMAT = 'opentrack-backup';
export const BACKUP_VERSION = 1;
export const BACKUP_SCHEMA = '0033_security.sql'; // the last migration this format matches
export const FILES_MAX = 50 * 1024 * 1024;
const CHUNK = 768 * 1024; // raw bytes per file_chunks row, as files.js

/**
 * Tables in restore order (parents before children). cols: the columns written (a list leaves secrets out), or '*'.
 * key: primary key columns (pagination order). page: rows per query. files: only with includeFiles.
 * project: the condition for a one-project export (alias t; `?` = the project id, repeated `n` times).
 */
export const TABLES = [
  { name: 'settings', cols: ['key', 'value'], key: ['key'], page: 200 },
  {
    name: 'users',
    cols: [
      'id',
      'email',
      'name',
      'title',
      'role',
      'status',
      'google_sub',
      'avatar_color',
      'avatar_version',
      'created_at',
      'updated_at',
      'last_login_at',
      'is_system',
    ],
    key: ['id'],
    page: 300,
    project: {
      cols: ['id', 'email', 'name', 'role', 'status'],
      sql: `t.id IN (SELECT user_id FROM project_members WHERE project_id = ?) OR t.id IN (SELECT assignee_id FROM issues WHERE project_id = ?)
            OR t.id IN (SELECT reporter_id FROM issues WHERE project_id = ?)
            OR t.id IN (SELECT lead_id FROM components WHERE project_id = ?) OR t.id IN (SELECT default_assignee_id FROM components WHERE project_id = ?)
            OR t.id IN (SELECT owner_id FROM raid_entries WHERE project_id = ?)`,
      n: 6,
    },
  },
  { name: 'user_avatars', cols: ['user_id', 'image', 'updated_at'], key: ['user_id'], page: 20, files: true },
  { name: 'projects', cols: '*', key: ['id'], page: 200, project: { sql: 't.id = ?', n: 1 } },
  { name: 'project_members', cols: '*', key: ['project_id', 'user_id'], page: 500, project: { sql: 't.project_id = ?', n: 1 } },
  { name: 'statuses', cols: '*', key: ['id'], page: 500, project: { sql: 't.project_id = ?', n: 1 } },
  { name: 'sprints', cols: '*', key: ['id'], page: 300, project: { sql: 't.project_id = ?', n: 1 } },
  { name: 'issues', cols: '*', key: ['id'], page: 150, project: { sql: 't.project_id = ?', n: 1 } },
  {
    name: 'issue_labels',
    cols: '*',
    key: ['issue_id', 'label'],
    page: 500,
    project: { sql: 't.issue_id IN (SELECT id FROM issues WHERE project_id = ?)', n: 1 },
  },
  {
    name: 'comments',
    cols: '*',
    key: ['id'],
    page: 200,
    project: { sql: 't.issue_id IN (SELECT id FROM issues WHERE project_id = ?)', n: 1 },
  },
  {
    name: 'comment_reactions',
    cols: '*',
    key: ['comment_id', 'user_id', 'reaction'],
    page: 500,
    project: { sql: 't.comment_id IN (SELECT cm.id FROM comments cm JOIN issues i ON i.id = cm.issue_id WHERE i.project_id = ?)', n: 1 },
  },
  {
    name: 'issue_history',
    cols: '*',
    key: ['id'],
    page: 500,
    project: { sql: 't.issue_id IN (SELECT id FROM issues WHERE project_id = ?)', n: 1 },
  },
  {
    name: 'issue_links',
    cols: '*',
    key: ['id'],
    page: 500,
    project: {
      sql: 't.source_id IN (SELECT id FROM issues WHERE project_id = ?) OR t.target_id IN (SELECT id FROM issues WHERE project_id = ?)',
      n: 2,
    },
  },
  {
    name: 'watchers',
    cols: '*',
    key: ['issue_id', 'user_id'],
    page: 500,
    project: { sql: 't.issue_id IN (SELECT id FROM issues WHERE project_id = ?)', n: 1 },
  },
  {
    name: 'worklogs',
    cols: '*',
    key: ['id'],
    page: 500,
    project: { sql: 't.issue_id IN (SELECT id FROM issues WHERE project_id = ?)', n: 1 },
  },
  // time tracking: running timers (one per person) and weeks submitted for approval (full backup only: they belong to people, not projects)
  { name: 'timers', cols: '*', key: ['user_id'], page: 500 },
  { name: 'timesheet_weeks', cols: '*', key: ['id'], page: 500 },
  {
    name: 'attachments',
    cols: '*',
    key: ['id'],
    page: 500,
    project: { sql: 't.issue_id IN (SELECT id FROM issues WHERE project_id = ?)', n: 1 },
  },
  { name: 'file_chunks', cols: ['file_id', 'seq', 'data'], key: ['file_id', 'seq'], page: 4, files: true },
  { name: 'issue_templates', cols: '*', key: ['id'], page: 300, project: { sql: 't.project_id = ?', n: 1 } },
  { name: 'custom_fields', cols: '*', key: ['id'], page: 300, project: { sql: 't.project_id = ?', n: 1 } },
  {
    name: 'issue_field_values',
    cols: '*',
    key: ['issue_id', 'field_id'],
    page: 500,
    project: { sql: 't.issue_id IN (SELECT id FROM issues WHERE project_id = ?)', n: 1 },
  },
  { name: 'components', cols: '*', key: ['id'], page: 300, project: { sql: 't.project_id = ?', n: 1 } },
  {
    name: 'issue_components',
    cols: '*',
    key: ['issue_id', 'component_id'],
    page: 500,
    project: { sql: 't.issue_id IN (SELECT id FROM issues WHERE project_id = ?)', n: 1 },
  },
  { name: 'releases', cols: '*', key: ['id'], page: 300, project: { sql: 't.project_id = ?', n: 1 } },
  {
    name: 'issue_releases',
    cols: '*',
    key: ['issue_id', 'release_id'],
    page: 500,
    project: { sql: 't.issue_id IN (SELECT id FROM issues WHERE project_id = ?)', n: 1 },
  },
  { name: 'recurring_rules', cols: '*', key: ['id'], page: 300, project: { sql: 't.project_id = ?', n: 1 } },
  {
    name: 'recurring_occurrences',
    cols: '*',
    key: ['id'],
    page: 500,
    project: { sql: 't.rule_id IN (SELECT id FROM recurring_rules WHERE project_id = ?)', n: 1 },
  },
  // channel AI sessions: linked Slack channels, the who-is-who prompts and the AI's suggestions (no Slack messages are stored)
  { name: 'project_channels', cols: '*', key: ['id'], page: 300, project: { sql: 't.project_id = ?', n: 1 } },
  {
    name: 'channel_links',
    cols: '*',
    key: ['id'],
    page: 300,
    project: { sql: 't.issue_id IN (SELECT id FROM issues WHERE project_id = ?)', n: 1 },
  },
  {
    name: 'ai_suggestions',
    cols: '*',
    key: ['id'],
    page: 500,
    project: { sql: 't.issue_id IN (SELECT id FROM issues WHERE project_id = ?)', n: 1 },
  },
  // project status reports (drafts and published; rag, sections and data are JSON text)
  { name: 'status_reports', cols: '*', key: ['id'], page: 200, project: { sql: 't.project_id = ?', n: 1 } },
  // project budgets, rates (with effective dates), per epic or component hours budgets, and the alerts already sent
  { name: 'project_budgets', cols: '*', key: ['project_id'], page: 300, project: { sql: 't.project_id = ?', n: 1 } },
  { name: 'budget_lines', cols: '*', key: ['id'], page: 500, project: { sql: 't.project_id = ?', n: 1 } },
  { name: 'budget_rates', cols: '*', key: ['id'], page: 500, project: { sql: 't.project_id = ?', n: 1 } },
  { name: 'budget_alerts', cols: '*', key: ['project_id', 'threshold'], page: 500, project: { sql: 't.project_id = ?', n: 1 } },
  // capacity planning: weekly hours per person, time off (with notes), and project allocation percentages
  { name: 'user_capacity', cols: '*', key: ['user_id'], page: 500 },
  { name: 'time_off', cols: '*', key: ['id'], page: 500 },
  { name: 'project_allocations', cols: '*', key: ['project_id', 'user_id'], page: 500, project: { sql: 't.project_id = ?', n: 1 } },
  // RAID log: risks, assumptions, issues and decisions, their linked issues and change history
  { name: 'raid_entries', cols: '*', key: ['id'], page: 300, project: { sql: 't.project_id = ?', n: 1 } },
  {
    name: 'raid_links',
    cols: '*',
    key: ['raid_id', 'issue_id'],
    page: 500,
    project: { sql: 't.raid_id IN (SELECT id FROM raid_entries WHERE project_id = ?)', n: 1 },
  },
  {
    name: 'raid_history',
    cols: '*',
    key: ['id'],
    page: 500,
    project: { sql: 't.raid_id IN (SELECT id FROM raid_entries WHERE project_id = ?)', n: 1 },
  },
  { name: 'brand_fonts', cols: '*', key: ['id'], page: 5 }, // workspace font files, base64 (full backup only)
  { name: 'saved_filters', cols: '*', key: ['id'], page: 300 },
  { name: 'project_templates', cols: '*', key: ['id'], page: 100 }, // saved project templates (full backup only)
  { name: 'board_views', cols: '*', key: ['id'], page: 300 },
  { name: 'board_view_defaults', cols: '*', key: ['user_id', 'project_id'], page: 500 },
  { name: 'reports', cols: '*', key: ['id'], page: 300 },
  { name: 'dashboards', cols: '*', key: ['id'], page: 300 },
  { name: 'project_slack', cols: '*', key: ['project_id'], page: 300 },
  { name: 'slack_users', cols: ['user_id', 'slack_user_id', 'looked_up_at', 'dm_enabled'], key: ['user_id'], page: 500 },
  { name: 'email_prefs', cols: '*', key: ['user_id'], page: 500 },
  { name: 'reminder_prefs', cols: '*', key: ['user_id'], page: 500 },
  {
    name: 'feedback',
    cols: ['id', 'user_id', 'kind', 'message', 'page', 'details', 'status', 'admin_note', 'created_at', 'updated_at'],
    key: ['id'],
    page: 200,
  },
  { name: 'audit_log', cols: '*', key: ['id'], page: 500 },
];

/** Tables and columns that must never appear in a backup (checked by test/backup.test.js). */
export const NEVER = {
  tables: [
    'sessions',
    'invites',
    'login_failures',
    'api_tokens',
    'oauth_clients',
    'oauth_codes',
    'oauth_refresh_tokens',
    'integrations',
    'feeds',
    'mcp_calls',
    'slack_errors',
    'email_errors',
    'jobs',
    'backups',
    'notifications',
    'jira_imports',
    'webhooks',
    'webhook_deliveries',
    'ai_errors',
    'recovery_codes',
    'login_challenges',
  ],
  columns: [
    'password_hash',
    'token_hash',
    'client_secret_hash',
    'code_hash',
    'screenshot',
    'jira_token',
    'signing_secret',
    'totp_secret',
    'totp_last_step',
    'totp_enabled_at',
  ],
};

/** Total bytes and count of attachments (for the include-files limit). */
export async function filesTotal(db, projectId = null) {
  const r = await db.get(
    `SELECT CAST(COUNT(*) AS INTEGER) AS n, CAST(COALESCE(SUM(size), 0) AS INTEGER) AS bytes FROM attachments${projectId ? ' WHERE issue_id IN (SELECT id FROM issues WHERE project_id = ?)' : ''}`,
    projectId ? [projectId] : [],
  );
  return { count: Number(r?.n) || 0, bytes: Number(r?.bytes) || 0 };
}

export function filesLimit(env) {
  return Number(env.BACKUP_FILES_MAX) > 0 ? Number(env.BACKUP_FILES_MAX) : FILES_MAX;
}

/** WHERE condition for "after this key" on (k1, k2, ...): k1 > ? OR (k1 = ? AND k2 > ?) ... */
function afterKey(key, last) {
  const parts = [];
  const params = [];
  for (let i = 0; i < key.length; i++) {
    const eq = key.slice(0, i).map((k) => `t.${k} = ?`);
    parts.push(`(${[...eq, `t.${key[i]} > ?`].join(' AND ')})`);
    params.push(...key.slice(0, i).map((k) => last[k]), last[key[i]]);
  }
  return { sql: `(${parts.join(' OR ')})`, params };
}

/** All rows of one table, page by page. */
async function* tableRows(db, table, { projectId = null } = {}) {
  const proj = projectId ? table.project : null;
  const cols = proj?.cols || table.cols;
  const select = cols === '*' ? 't.*' : cols.map((c) => `t.${c}`).join(', ');
  const order = table.key.map((k) => `t.${k}`).join(', ');
  let last = null;
  for (;;) {
    const where = [];
    const params = [];
    if (proj) {
      where.push(`(${proj.sql})`);
      for (let i = 0; i < proj.n; i++) params.push(projectId);
    }
    if (last) {
      const a = afterKey(table.key, last);
      where.push(a.sql);
      params.push(...a.params);
    }
    const rows = await db.all(
      `SELECT ${select} FROM ${table.name} t${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ?`,
      [...params, table.page],
    );
    if (!rows.length) return;
    yield rows;
    if (rows.length < table.page) return;
    last = rows[rows.length - 1];
  }
}

/** Bytes of attachments kept in R2/GCS, as file_chunks rows (so a restore can keep them in the database). */
async function* externalFileRows(env, db, projectId, stats) {
  let after = '';
  for (;;) {
    const rows = await db.all(
      `SELECT id, storage FROM attachments WHERE storage <> 'db' AND id > ?${projectId ? ' AND issue_id IN (SELECT id FROM issues WHERE project_id = ?)' : ''} ORDER BY id LIMIT 50`,
      projectId ? [after, projectId] : [after],
    );
    if (!rows.length) return;
    for (const a of rows) {
      let bytes = null;
      try {
        bytes = await fileStore(env, a.storage)?.get(a.id);
      } catch (e) {
        console.error('backup: file read failed', a.id, e?.message);
      }
      if (!bytes) {
        stats.missingFiles.push(a.id);
        continue;
      }
      const out = [];
      for (let seq = 0, off = 0; off < bytes.length || seq === 0; seq++, off += CHUNK)
        out.push({ file_id: a.id, seq, data: toBase64(bytes.subarray(off, off + CHUNK)) });
      yield out;
    }
    if (rows.length < 50) return;
    after = rows[rows.length - 1].id;
  }
}

/**
 * The backup as an async generator of JSON text pieces.
 * opts: includeFiles, project ({ id, key, name } for a one-project export), stats (filled in: rows per table).
 */
export async function* backupJson(env, opts = {}) {
  const db = env.db;
  const stats = opts.stats || { rows: {}, missingFiles: [] };
  stats.missingFiles = stats.missingFiles || [];
  const project = opts.project || null;
  const tables = TABLES.filter(
    (t) => (project ? t.project || (t.files && opts.includeFiles && t.name === 'file_chunks') : true) && (!t.files || opts.includeFiles),
  );
  const settings = await getSettings(db);
  const head = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    schema: BACKUP_SCHEMA,
    createdAt: new Date().toISOString(),
    appName: settings.appName,
    includesFiles: Boolean(opts.includeFiles),
    project: project ? { id: project.id, key: project.key, name: project.name } : null,
    tableOrder: tables.map((t) => t.name),
  };
  yield `${JSON.stringify(head).slice(0, -1)},"tables":{`;
  let firstTable = true;
  for (const t of tables) {
    const nl = opts.lines ? '\n' : ''; // one row per line (GitHub copy: readable diffs)
    yield `${firstTable ? '' : ','}${nl}${JSON.stringify(t.name)}:[`;
    firstTable = false;
    let n = 0;
    const pages = t.name === 'file_chunks' && project ? projectChunks(db, project.id) : tableRows(db, t, { projectId: project?.id });
    for await (const rows of pages) {
      yield `${n ? ',' : ''}${nl}${rows.map((r) => JSON.stringify(r)).join(`,${nl}`)}`;
      n += rows.length;
    }
    if (t.name === 'file_chunks') {
      for await (const rows of externalFileRows(env, db, project?.id, stats)) {
        yield `${n ? ',' : ''}${rows.map((r) => JSON.stringify(r)).join(',')}`;
        n += rows.length;
      }
    }
    yield ']';
    stats.rows[t.name] = n;
  }
  yield `},"rowCounts":${JSON.stringify(stats.rows)},"missingFiles":${JSON.stringify(stats.missingFiles)},"complete":true}`;
}

/** file_chunks of one project's attachments (stored in the database), a few rows at a time. */
async function* projectChunks(db, projectId) {
  let last = null;
  for (;;) {
    const params = [projectId];
    let after = '';
    if (last) {
      after = ' AND (f.file_id > ? OR (f.file_id = ? AND f.seq > ?))';
      params.push(last.file_id, last.file_id, last.seq);
    }
    const rows = await db.all(
      `SELECT f.file_id, f.seq, f.data FROM file_chunks f JOIN attachments a ON a.id = f.file_id JOIN issues i ON i.id = a.issue_id
        WHERE i.project_id = ?${after} ORDER BY f.file_id, f.seq LIMIT 4`,
      params,
    );
    if (!rows.length) return;
    yield rows;
    if (rows.length < 4) return;
    last = rows[rows.length - 1];
  }
}

/**
 * A ReadableStream of bytes from an async generator of strings. onEnd(error | null, { bytes }) is called once,
 * when the stream finishes, fails or is cancelled.
 */
export function textStream(gen, onEnd) {
  const enc = new TextEncoder();
  let bytes = 0;
  let ended = false;
  const end = async (err) => {
    if (ended) return;
    ended = true;
    try {
      await onEnd?.(err, { bytes });
    } catch (e) {
      console.error('backup: could not record the result', e);
    }
  };
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await gen.next();
        if (done) {
          await end(null);
          controller.close();
          return;
        }
        const b = enc.encode(value);
        bytes += b.length;
        controller.enqueue(b);
      } catch (e) {
        await end(e);
        controller.error(e);
      }
    },
    async cancel() {
      try {
        await gen.return?.();
      } catch {
        /* ignore */
      }
      await end(new Error('The download was stopped before it finished'));
    },
  });
}

// ---- backup records (Admin > Backups) ----

export async function startRecord(db, kind, actorId, destination = null) {
  const id = uuid();
  await db.run('INSERT INTO backups (id, kind, status, started_at, destination, actor_id) VALUES (?, ?, ?, ?, ?, ?)', [
    id,
    kind,
    'running',
    new Date().toISOString(),
    destination,
    actorId,
  ]);
  return id;
}

export async function finishRecord(db, id, { error = null, size = null, rows = null } = {}) {
  await db.run('UPDATE backups SET status = ?, finished_at = ?, size = ?, row_count = ?, error = ? WHERE id = ?', [
    error ? 'error' : 'ok',
    new Date().toISOString(),
    size,
    rows,
    error ? String(error.message || error).slice(0, 500) : null,
    id,
  ]);
  // keep the last 50 records
  await db.run('DELETE FROM backups WHERE started_at < (SELECT started_at FROM backups ORDER BY started_at DESC LIMIT 1 OFFSET 49)', []);
}

export const sumRows = (stats) => Object.values(stats.rows).reduce((a, b) => a + b, 0);

// ---- the daily automatic copy ----

/** Where the daily backup goes: { type: 'webhook', url, host } | { type: 'gcs', bucket } | null. */
export function backupDestination(env) {
  if (env.BACKUP_WEBHOOK_URL) {
    let host = 'webhook';
    try {
      host = new URL(env.BACKUP_WEBHOOK_URL).host;
    } catch {
      /* invalid URL: the run reports it */
    }
    return { type: 'webhook', url: env.BACKUP_WEBHOOK_URL, host, label: `Webhook ${host}` };
  }
  if (env.GCS_BACKUP_BUCKET) return { type: 'gcs', bucket: env.GCS_BACKUP_BUCKET, label: `gs://${env.GCS_BACKUP_BUCKET}` };
  return null;
}

/** Gzip the stream where CompressionStream exists (Workers, Node 18+). Returns { stream, gzip }. */
function maybeGzip(stream) {
  if (typeof CompressionStream === 'undefined') return { stream, gzip: false };
  return { stream: stream.pipeThrough(new CompressionStream('gzip')), gzip: true };
}

/** Count the bytes that pass through. */
function counter() {
  const box = { bytes: 0 };
  const ts = new TransformStream({
    transform(chunk, controller) {
      box.bytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  return { ts, box };
}

const fmtSize = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/**
 * The backup job (server/lib/jobs.js): sends a full backup without file bytes to the configured destination.
 * Nothing to do (and nothing recorded) when no destination is configured.
 */
export async function runBackupJob(ctx, counts) {
  const env = ctx.env;
  const db = ctx.db;
  const dest = backupDestination(env);
  if (!dest) {
    counts.skipped = true;
    counts.summary = 'No destination configured (BACKUP_WEBHOOK_URL or GCS_BACKUP_BUCKET): nothing sent';
    return { status: 'done' };
  }
  const stamp = new Date(ctx.nowMs).toISOString().replace(/[:.]/g, '-');
  const stats = { rows: {}, missingFiles: [] };
  const raw = textStream(backupJson(env, { stats }), null);
  const { stream: zipped, gzip } = maybeGzip(raw);
  const { ts, box } = counter();
  const body = zipped.pipeThrough(ts);
  const name = `tracker-backup-${stamp}.json${gzip ? '.gz' : ''}`;
  const destination = dest.type === 'gcs' ? `gs://${dest.bucket}/backups/${name}` : dest.label;
  const id = await startRecord(db, dest.type, null, destination);
  try {
    if (dest.type === 'webhook') {
      const headers = { 'content-type': 'application/json', 'x-backup-filename': name };
      if (gzip) headers['content-encoding'] = 'gzip';
      if (env.BACKUP_WEBHOOK_SECRET) headers['x-backup-secret'] = String(env.BACKUP_WEBHOOK_SECRET);
      const doFetch = env.fetch || ((...a) => fetch(...a));
      const res = await doFetch(dest.url, { method: 'POST', headers, body, duplex: 'half' });
      if (!res.ok) throw new Error(`The webhook answered ${res.status}`);
    } else {
      await gcsUpload(env, dest.bucket, `backups/${name}`, body, gzip ? 'application/gzip' : 'application/json');
    }
    await finishRecord(db, id, { size: box.bytes, rows: sumRows(stats) });
    Object.assign(counts, {
      destination,
      size: box.bytes,
      rows: sumRows(stats),
      summary: `Sent ${fmtSize(box.bytes)} (${sumRows(stats)} rows) to ${destination}`,
    });
    return { status: 'done' };
  } catch (e) {
    console.error('backup: failed', e);
    await finishRecord(db, id, { error: e });
    Object.assign(counts, { destination, summary: `Failed: ${String(e?.message || e).slice(0, 200)}` });
    return { status: 'error', error: String(e?.message || e).slice(0, 500) };
  }
}
