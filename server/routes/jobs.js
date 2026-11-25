// Scheduled jobs (admin), the weekly digest page and personal reminder preferences. See server/lib/jobs.js.
import { body, fail } from '../lib/http.js';
import { now } from '../lib/crypto.js';
import { requireAdmin } from '../lib/session.js';
import { audit } from '../lib/audit.js';
import { getSettings } from '../lib/settings.js';
import { JOBS, runDueJobs, jobsStatus } from '../lib/jobs.js';
import { buildDigest } from '../lib/jobs/digest.js';
import { clock, workspaceTz } from '../lib/time.js';

const JOB_PATHS = ['/api/admin/jobs', '/api/admin/jobs/run'];

function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** `Authorization: Bearer <JOBS_SECRET>` on the jobs endpoints (an external scheduler; no user). */
export function isJobsSecretRequest(c) {
  const secret = c.env.JOBS_SECRET;
  if (!secret || String(secret).length < 16 || !JOB_PATHS.includes(c.req.path)) return false;
  const m = (c.req.header('authorization') || '').match(/^Bearer\s+(\S+)$/);
  return Boolean(m && sameText(m[1], String(secret)));
}

function requireJobsAccess(c) {
  if (c.get('jobsSecret')) return;
  requireAdmin(c);
}

const PREF_KEYS = { dueSlack: 'due_slack', dueEmail: 'due_email', digestSlack: 'digest_slack', digestEmail: 'digest_email' };
function prefsOut(row) {
  const out = {};
  for (const [k, col] of Object.entries(PREF_KEYS))
    out[k] = !row || row[col] === null || row[col] === undefined ? true : Boolean(Number(row[col]));
  return out;
}

export function registerJobs(app) {
  app.get('/api/admin/jobs', async (c) => {
    requireJobsAccess(c);
    return c.json(await jobsStatus(c.env.db, c.env));
  });

  // Admin Run now ({ name }) or an external scheduler (no name: runs whatever is due, one slice).
  app.post('/api/admin/jobs/run', async (c) => {
    requireJobsAccess(c);
    const b = await body(c);
    if (b.name !== undefined && !JOBS[b.name]) fail(400, `name must be one of: ${Object.keys(JOBS).join(', ')}`);
    const r = await runDueJobs(c, b.name ? { force: b.name } : {});
    if (b.name && c.get('user'))
      await c.env.db.batch([audit(c.get('user').id, 'job.run', 'job', b.name, { status: r.status || r.reason || null })]);
    return c.json({ ...r, ...(await jobsStatus(c.env.db, c.env)) });
  });

  app.patch('/api/admin/jobs/:name', async (c) => {
    requireAdmin(c);
    const name = c.req.param('name');
    if (!JOBS[name]) fail(404, 'Job not found');
    const b = await body(c);
    const sets = [];
    const params = [];
    if (b.hour !== undefined) {
      if (!Number.isInteger(b.hour) || b.hour < 0 || b.hour > 23) fail(400, 'hour must be a whole number from 0 to 23');
      sets.push('hour = ?');
      params.push(b.hour);
    }
    if (b.weekday !== undefined) {
      if (!JOBS[name].weekly) fail(400, 'Only weekly jobs have a day');
      if (!Number.isInteger(b.weekday) || b.weekday < 0 || b.weekday > 6) fail(400, 'weekday must be 0 (Sunday) to 6 (Saturday)');
      sets.push('weekday = ?');
      params.push(b.weekday);
    }
    if (b.enabled !== undefined) {
      if (typeof b.enabled !== 'boolean') fail(400, 'enabled must be true or false');
      sets.push('enabled = ?');
      params.push(b.enabled ? 1 : 0);
    }
    if (sets.length) {
      await c.env.db.batch([
        { sql: `UPDATE jobs SET ${sets.join(', ')} WHERE name = ?`, params: [...params, name] },
        audit(c.get('user').id, 'job.updated', 'job', name, { hour: b.hour, weekday: b.weekday, enabled: b.enabled }),
      ]);
    }
    return c.json(await jobsStatus(c.env.db, c.env));
  });

  // The signed-in person's weekly digest, computed now.
  app.get('/api/digest', async (c) => {
    const settings = await getSettings(c.env.db);
    return c.json(await buildDigest(c.env.db, c.get('user'), { nowMs: clock(c.env), tz: workspaceTz(settings) }));
  });

  app.get('/api/me/reminders', async (c) => {
    const row = await c.env.db.get('SELECT * FROM reminder_prefs WHERE user_id = ?', [c.get('user').id]);
    return c.json({ prefs: prefsOut(row) });
  });

  app.put('/api/me/reminders', async (c) => {
    const b = await body(c);
    const db = c.env.db;
    const uid = c.get('user').id;
    const prefs = prefsOut(await db.get('SELECT * FROM reminder_prefs WHERE user_id = ?', [uid]));
    for (const k of Object.keys(PREF_KEYS)) {
      if (b[k] === undefined) continue;
      if (typeof b[k] !== 'boolean') fail(400, `${k} must be true or false`);
      prefs[k] = b[k];
    }
    await db.run(
      `INSERT INTO reminder_prefs (user_id, due_slack, due_email, digest_slack, digest_email, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET due_slack = excluded.due_slack, due_email = excluded.due_email,
         digest_slack = excluded.digest_slack, digest_email = excluded.digest_email, updated_at = excluded.updated_at`,
      [uid, prefs.dueSlack ? 1 : 0, prefs.dueEmail ? 1 : 0, prefs.digestSlack ? 1 : 0, prefs.digestEmail ? 1 : 0, now()],
    );
    return c.json({ prefs });
  });
}
