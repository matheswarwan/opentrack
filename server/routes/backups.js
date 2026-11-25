// Backups (Admin > Backups) and per-project exports (project settings). See server/lib/backup.js.
//   GET /api/admin/backups                 status: destination, recent backups, files total, the backup job
//   GET /api/admin/backup?files=1          download a full JSON backup (streamed); files=1 adds file bytes
//   GET /api/projects/:key/export.json     one project as JSON (same format, project tables only), project admins
//   GET /api/projects/:key/export.csv      the project's issues as CSV, project admins
import { githubBackupConfig, runGithubBackup } from '../lib/githubBackup.js';
import { fail } from '../lib/http.js';
import { requireAdmin } from '../lib/session.js';
import { audit } from '../lib/audit.js';
import { projectAccess } from '../lib/access.js';
import { jobsStatus } from '../lib/jobs.js';
import { backupJson, textStream, filesTotal, filesLimit, backupDestination, startRecord, finishRecord, sumRows } from '../lib/backup.js';
import { searchIssues } from '../lib/issues/search.js';
import { placeholders } from '../db/sql.js';
import { csvCell } from '../lib/csv.js';

const today = () => new Date().toISOString().slice(0, 10);

export const PROJECT_CSV_COLUMNS = [
  'Key',
  'Type',
  'Title',
  'Status',
  'Priority',
  'Assignee',
  'Reporter',
  'Parent',
  'Sprint',
  'Story points',
  'Estimate hours',
  'Due',
  'Labels',
  'Created',
  'Updated',
  'Resolved',
  'Description',
];

/** The project's live issues as CSV lines, 80 at a time (descriptions are read per page). */
async function* projectCsv(db, user, project) {
  yield `${PROJECT_CSV_COLUMNS.join(',')}\n`;
  for (let offset = 0; ; offset += 80) {
    const r = await searchIssues(
      db,
      user,
      { project: project.key, archived: '1', sort: 'key', dir: 'asc', limit: 80, offset },
      { blocked: false },
    );
    if (!r.issues.length) return;
    const ids = r.issues.map((i) => i.id);
    const desc = new Map(
      (await db.all(`SELECT id, description FROM issues WHERE id IN (${placeholders(ids.length)})`, ids)).map((x) => [x.id, x.description]),
    );
    yield (
      r.issues
        .map((i) =>
          [
            i.key,
            i.type,
            i.title,
            i.status.name,
            i.priority,
            i.assignee?.name,
            i.reporter?.name,
            i.parent?.key,
            i.sprint?.name,
            i.storyPoints,
            i.estimateHours,
            i.dueDate,
            i.labels.join(' '),
            i.createdAt,
            i.updatedAt,
            i.resolvedAt,
            desc.get(i.id),
          ]
            .map(csvCell)
            .join(','),
        )
        .join('\n') + '\n'
    );
    if (r.issues.length < 80) return;
  }
}

export function registerBackups(app) {
  app.get('/api/admin/backups', async (c) => {
    requireAdmin(c);
    const db = c.env.db;
    const dest = backupDestination(c.env);
    const gh = githubBackupConfig(c.env);
    const [runs, files, jobs] = await Promise.all([
      db.all(`SELECT b.*, u.name AS actor_name FROM backups b LEFT JOIN users u ON u.id = b.actor_id ORDER BY b.started_at DESC LIMIT 20`),
      filesTotal(db),
      jobsStatus(db, c.env),
    ]);
    return c.json({
      destination: dest ? { type: dest.type, label: dest.label } : null,
      github: gh
        ? { repo: gh.repo, branch: gh.branch, path: gh.path, ready: gh.valid && gh.hasToken, hasToken: gh.hasToken, valid: gh.valid }
        : null,
      githubJob: jobs.jobs.find((j) => j.name === 'github_backup') || null,
      files: { ...files, limit: filesLimit(c.env) },
      job: jobs.jobs.find((j) => j.name === 'backup') || null,
      runs: runs.map((r) => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        size: r.size,
        rows: r.row_count,
        destination: r.destination,
        error: r.error,
        by: r.actor_name || null,
      })),
    });
  });

  // Back up to GitHub now (the job also runs every 6 hours)
  app.post('/api/admin/backups/github', async (c) => {
    requireAdmin(c);
    const user = c.get('user');
    if (!githubBackupConfig(c.env))
      fail(400, 'GitHub backup is not set up: GITHUB_BACKUP_REPO and GITHUB_BACKUP_TOKEN are needed on the server');
    const r = await runGithubBackup(c.env, user.id);
    await c.env.db.batch([
      audit(user.id, 'backup.github', 'backup', null, { ok: r.ok, destination: r.destination, commit: r.commit || null }),
    ]);
    if (!r.ok) fail(502, r.error);
    return c.json(r);
  });

  app.get('/api/admin/backup', async (c) => {
    requireAdmin(c);
    const db = c.env.db;
    const user = c.get('user');
    const includeFiles = c.req.query('files') === '1';
    if (includeFiles) {
      const f = await filesTotal(db);
      const max = filesLimit(c.env);
      if (f.bytes > max)
        fail(
          400,
          `Attached files total ${(f.bytes / 1024 / 1024).toFixed(1)} MB, more than the ${Math.round(max / 1024 / 1024)} MB a download can include. Download without files.`,
        );
    }
    const id = await startRecord(db, 'download', user.id, includeFiles ? 'Download with files' : 'Download');
    await db.batch([audit(user.id, 'backup.downloaded', 'backup', id, { includeFiles })]);
    const stats = { rows: {}, missingFiles: [] };
    const stream = textStream(backupJson(c.env, { includeFiles, stats }), (err, s) =>
      finishRecord(db, id, { error: err, size: s.bytes, rows: sumRows(stats) }),
    );
    return new Response(stream, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="tracker-backup-${today()}.json"`,
        'cache-control': 'no-store',
      },
    });
  });

  app.get('/api/projects/:key/export.json', async (c) => {
    const { project } = await projectAccess(c, c.req.param('key'), 'admin');
    const includeFiles = c.req.query('files') === '1';
    if (includeFiles) {
      const f = await filesTotal(c.env.db, project.id);
      if (f.bytes > filesLimit(c.env)) fail(400, "This project's files are too large to include. Export without files.");
    }
    await c.env.db.batch([audit(c.get('user').id, 'project.exported', 'project', project.id, { format: 'json', includeFiles })]);
    const stream = textStream(backupJson(c.env, { project, includeFiles }), null);
    return new Response(stream, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${project.key}-export-${today()}.json"`,
        'cache-control': 'no-store',
      },
    });
  });

  app.get('/api/projects/:key/export.csv', async (c) => {
    const { project } = await projectAccess(c, c.req.param('key'), 'admin');
    await c.env.db.batch([audit(c.get('user').id, 'project.exported', 'project', project.id, { format: 'csv' })]);
    const stream = textStream(projectCsv(c.env.db, c.get('user'), project), null);
    return new Response(stream, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${project.key}-issues-${today()}.csv"`,
        'cache-control': 'no-store',
      },
    });
  });
}
