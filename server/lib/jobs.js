// Scheduled jobs without a cron trigger (the Cloudflare account has no free cron slots left).
//
// How a job gets run:
//   1. Any signed-in API request: app.js calls scheduleJobs(c) after the response. At most once a minute per
//      isolate (in-memory timestamp) it checks the jobs table and runs one slice of one due job in the background
//      (executionCtx.waitUntil on Workers; a caught promise on Node). Turn this off with JOBS_AUTO=off.
//   2. POST /api/admin/jobs/run: an admin (Run now) or an external scheduler (Cloud Scheduler, GitHub Actions)
//      with `Authorization: Bearer <JOBS_SECRET>`.
// A job is due once its local hour (timeZone setting) has passed on its day and it has not run for that day yet.
// Claiming a run is one conditional UPDATE checked for changes === 1, so two requests never both start it.
//
// Bounded runs: D1 on the free plan allows about 50 queries (and 50 subrequests) per request, and the request
// that triggers a job has used some already. A slice stops when its budget (JOBS_MAX_QUERIES, JOBS_MAX_FETCHES;
// larger defaults on Postgres) runs low, saves the last user id as `cursor` with status 'partial', and the next
// trigger continues from there. Each person gets at most one reminder and one digest per local day: before
// sending, the job looks for that day's in-app notification, which is written first, so a resumed or repeated
// run never sends twice.
//
// This file is the runner: the job list, the schedule, claiming a run, the budget and the status the admin page
// shows. The jobs themselves: jobs/reminders.js, jobs/digest.js (both loop over people with jobs/people.js),
// jobs/purge.js, and backup.js, githubBackup.js, recurring.js and channelAi.js for the rest.
import { runGithubBackupJob } from './githubBackup.js';
import { getSettings } from './settings.js';
import { clock, localParts, addDays, workspaceTz } from './time.js';
import { runBackupJob } from './backup.js';
import { runRecurring } from './recurring.js';
import { runChannelAi } from './channelAi.js';
import { defer, publicOrigin } from './http.js';
import { parseJson, parseObject } from './json.js';
import { forEachPerson, PEOPLE_COUNTS } from './jobs/people.js';
import { remindUser } from './jobs/reminders.js';
import { digestUser } from './jobs/digest.js';
import { purgeTrash } from './jobs/purge.js';

// Listed in the order they are tried when several are due: the people-facing jobs first.
// Every job has run(ctx, counts, room) -> { status, error } (see runJob). counts: the result's starting numbers.
export const JOBS = {
  due_reminders: { label: 'Due-date reminders', weekly: false, counts: PEOPLE_COUNTS, run: forEachPerson(remindUser) },
  weekly_digest: { label: 'Weekly digest', weekly: true, counts: PEOPLE_COUNTS, run: forEachPerson(digestUser) },
  trash_purge: { label: 'Empty old Trash items', weekly: false, run: purgeTrash },
  backup: { label: 'Automatic backup copy', weekly: false, run: (ctx, counts) => runBackupJob(ctx, counts) },
  // copy of the full backup committed to a GitHub repository every 6 hours (server/lib/githubBackup.js)
  github_backup: {
    label: 'Backup to GitHub',
    weekly: false,
    everyMinutes: 360,
    active: (s, env) => Boolean(env?.GITHUB_BACKUP_REPO && env?.GITHUB_BACKUP_TOKEN),
    run: (ctx, counts) => runGithubBackupJob(ctx, counts),
  },
  recurring: { label: 'Recurring issues', weekly: false, run: (ctx, counts, room) => runRecurring(ctx, counts, room) },
  // everyMinutes: an interval job (runs again that many minutes after its last run finished; no hour or day).
  // active(settings, env): false skips it on automatic runs (Run now still works).
  channel_ai: {
    label: 'Channel AI sessions',
    weekly: false,
    everyMinutes: 30,
    active: (s) => Boolean(s.channelAi),
    run: (ctx, counts, room) => runChannelAi(ctx, counts, room),
  },
};
const DEFAULT_HOURS = { trash_purge: 3, backup: 2, recurring: 6 };
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const STALE_MS = 10 * 60e3; // a 'running' slice older than this is taken over (its isolate died)
const THROTTLE_MS = 60e3;
const WEEKLY_CATCH_UP_DAYS = 2; // a weekly job missed on its day (no traffic) still runs up to 2 days later
const USER_RESERVE = { queries: 10, fetches: 5 }; // worst case for one person, plus the final status update

// ---- schedule ----

/**
 * The local date this job's current run belongs to, or null when it is not due yet today.
 * Daily: today once the hour has passed. Weekly: the latest scheduled day, up to WEEKLY_CATCH_UP_DAYS back.
 */
export function periodStart(job, parts) {
  if (job.weekday === null || job.weekday === undefined) return parts.hour >= job.hour ? parts.date : null;
  let back = (parts.weekday - Number(job.weekday) + 7) % 7;
  if (back === 0 && parts.hour < job.hour) return null;
  if (back > WEEKLY_CATCH_UP_DAYS) return null;
  return addDays(parts.date, -back);
}

/** Next scheduled local date and hour (or dueNow when it would run on the next trigger). */
export function nextRun(job, parts) {
  const ps = periodStart(job, parts);
  if (job.enabled && ps && (!job.last_run_on || job.last_run_on < ps)) return { dueNow: true, date: parts.date, hour: job.hour };
  for (let d = 0; d <= 8; d++) {
    const date = addDays(parts.date, d);
    const wd = (parts.weekday + d) % 7;
    if (job.weekday !== null && job.weekday !== undefined && wd !== Number(job.weekday)) continue;
    if (d === 0 && (parts.hour >= job.hour || (job.last_run_on && job.last_run_on >= date))) continue;
    return { dueNow: false, date, hour: job.hour };
  }
  return null;
}

// ---- jobs table ----

export async function loadJobs(db) {
  let rows = await db.all('SELECT * FROM jobs ORDER BY name');
  const missing = Object.keys(JOBS).filter((n) => !rows.some((r) => r.name === n));
  if (missing.length) {
    for (const n of missing) {
      await db.run('INSERT INTO jobs (name, hour, weekday, enabled) VALUES (?, ?, ?, 1) ON CONFLICT (name) DO NOTHING', [
        n,
        DEFAULT_HOURS[n] ?? 8,
        JOBS[n].weekly ? 1 : null,
      ]);
    }
    rows = await db.all('SELECT * FROM jobs ORDER BY name');
  }
  const order = Object.keys(JOBS);
  return rows.filter((r) => JOBS[r.name]).sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
}

/** Start a new run for `period` (a local date). True only for the one caller whose UPDATE changed the row. */
export async function claimRun(db, name, period, nowMs) {
  const r = await db.run(
    `UPDATE jobs SET last_run_on = ?, started_at = ?, status = 'running', cursor = NULL, result = NULL, error = NULL, finished_at = NULL
      WHERE name = ? AND (last_run_on IS NULL OR last_run_on < ?)`,
    [period, new Date(nowMs).toISOString(), name, period],
  );
  return r.changes === 1;
}

/** Continue a partial run (or take over one whose slice died). */
async function claimContinue(db, job, nowMs) {
  const r = await db.run(
    `UPDATE jobs SET status = 'running', started_at = ? WHERE name = ? AND last_run_on = ?
        AND (status = 'partial' OR (status = 'running' AND started_at < ?))`,
    [new Date(nowMs).toISOString(), job.name, job.last_run_on, new Date(nowMs - STALE_MS).toISOString()],
  );
  return r.changes === 1;
}

/** Run now (admin or scheduler): continue a partial run of today, else start a fresh one unless one is running. */
async function claimForce(db, job, today, nowMs) {
  if (job.last_run_on === today && (job.status === 'partial' || job.status === 'running') && (await claimContinue(db, job, nowMs)))
    return 'continue';
  const r = await db.run(
    `UPDATE jobs SET last_run_on = ?, started_at = ?, status = 'running', cursor = NULL, result = NULL, error = NULL, finished_at = NULL
      WHERE name = ? AND (status IS NULL OR status <> 'running' OR started_at < ?)`,
    [today, new Date(nowMs).toISOString(), job.name, new Date(nowMs - STALE_MS).toISOString()],
  );
  return r.changes === 1 ? 'fresh' : null;
}

/** Is an interval job (JOBS[name].everyMinutes) due: a part-done run, a stale slice, or the interval has passed. */
export function intervalDue(job, nowMs) {
  const every = JOBS[job.name]?.everyMinutes;
  if (!every) return false;
  if (job.status === 'running') return Boolean(job.started_at) && job.started_at < new Date(nowMs - STALE_MS).toISOString();
  if (job.status === 'partial') return true;
  return !job.finished_at || job.finished_at <= new Date(nowMs - every * 60e3).toISOString();
}

/** Claim an interval job if nobody changed it since it was read (status and started_at unchanged). */
async function claimInterval(db, job, today, nowMs) {
  const r = await db.run(
    `UPDATE jobs SET last_run_on = ?, started_at = ?, status = 'running', error = NULL, finished_at = NULL, cursor = NULL,
            result = CASE WHEN status = 'partial' THEN result ELSE NULL END
      WHERE name = ? AND COALESCE(status, '') = ? AND COALESCE(started_at, '') = ?`,
    [today, new Date(nowMs).toISOString(), job.name, job.status || '', job.started_at || ''],
  );
  return r.changes === 1;
}

// ---- budget ----

function limits(env, db) {
  const big = db.dialect === 'postgres';
  return {
    queries: Number(env.JOBS_MAX_QUERIES) || (big ? 2000 : 35),
    fetches: Number(env.JOBS_MAX_FETCHES) || (big ? 1000 : 30),
    batch: Math.min(Math.max(Number(env.JOBS_BATCH) || 20, 1), 90),
  };
}

/** An env whose db and fetch count their calls, so a slice can stop before the platform limits. */
function budgeted(env) {
  const db = env.db;
  const used = { queries: 0, fetches: 0 };
  const count = (n) => (used.queries += n);
  const wrapped = {
    dialect: db.dialect,
    all: (s, p) => (count(1), db.all(s, p)),
    get: (s, p) => (count(1), db.get(s, p)),
    run: (s, p) => (count(1), db.run(s, p)),
    batch: (st) => (count(Math.max(1, st.length)), db.batch(st)),
  };
  const baseFetch = env.fetch || ((...a) => fetch(...a));
  return { env: { ...env, db: wrapped, fetch: (...a) => ((used.fetches += 1), baseFetch(...a)) }, used };
}

// ---- triggering ----

let lastCheckAt = 0;
/** Tests: forget the once-a-minute check. */
export function resetJobThrottle() {
  lastCheckAt = 0;
}

/** Called after an authenticated API request: runs due jobs in the background, at most once a minute per isolate. */
export function scheduleJobs(c) {
  try {
    if (String(c.env.JOBS_AUTO || '').toLowerCase() === 'off') return;
    const t = Date.now();
    if (Math.abs(t - lastCheckAt) < THROTTLE_MS) return;
    lastCheckAt = t;
    defer(c, runDueJobs(c), { label: 'jobs: run failed', queue: c.env.jobsQueue });
  } catch (e) {
    console.error('jobs: could not schedule', e);
  }
}

function originOf(c) {
  try {
    return publicOrigin(c);
  } catch {
    return (c.env.PUBLIC_URL || '').replace(/\/$/, '');
  }
}

/**
 * Run one slice of one job. opts.force = job name (Run now); without it, the first due or partial job.
 * Returns { ran: name | null, status, result } for the caller.
 */
export async function runDueJobs(c, opts = {}) {
  const { env, used } = budgeted(c.env);
  const db = env.db;
  const nowMs = clock(c.env);
  const settings = await getSettings(db);
  const tz = workspaceTz(settings);
  const parts = localParts(nowMs, tz);
  const jobs = await loadJobs(db);
  let job = null;
  if (opts.force) {
    job = jobs.find((j) => j.name === opts.force);
    if (!job) return { ran: null, reason: 'unknown job' };
    const how = await claimForce(db, job, parts.date, nowMs);
    if (!how) return { ran: null, reason: 'already running' };
    if (how === 'fresh') job = { ...job, last_run_on: parts.date, cursor: null, result: null };
  } else {
    for (const j of jobs) {
      if (!Number(j.enabled)) continue;
      if (JOBS[j.name].everyMinutes) {
        if (JOBS[j.name].active && !JOBS[j.name].active(settings, env)) continue;
        if (intervalDue(j, nowMs) && (await claimInterval(db, j, parts.date, nowMs))) {
          job = { ...j, last_run_on: parts.date, result: j.status === 'partial' ? j.result : null };
          break;
        }
        continue;
      }
      const ps = periodStart(j, parts);
      if (ps && (!j.last_run_on || j.last_run_on < ps)) {
        if (await claimRun(db, j.name, ps, nowMs)) {
          job = { ...j, last_run_on: ps, cursor: null, result: null };
          break;
        }
        continue;
      }
      const stale = j.status === 'running' && j.started_at && j.started_at < new Date(nowMs - STALE_MS).toISOString();
      if (j.last_run_on && (j.status === 'partial' || stale) && (await claimContinue(db, j, nowMs))) {
        job = j;
        break;
      }
    }
    if (!job) return { ran: null };
  }
  const ctx = {
    env,
    db,
    used,
    lim: limits(c.env, c.env.db),
    nowMs,
    tz,
    parts,
    period: job.last_run_on,
    origin: originOf(c),
    appName: settings.appName,
  };
  return runJob(ctx, job);
}

/**
 * Run one slice of a claimed job and save how it ended. Every job is a run(ctx, counts, room) from JOBS:
 *   counts  the run's result so far (kept across slices in jobs.result); the job adds its own numbers
 *   room()  false once the slice's budget runs low: the job stops and returns { status: 'partial' }
 *   ctx.resume  where the last slice stopped (jobs.cursor), ctx.cursor  where this one got to (saved unless done)
 * It returns { status: 'done' | 'partial' | 'error', error }; a throw counts as an error.
 */
async function runJob(ctx, job) {
  const def = JOBS[job.name];
  const counts = { ...(def.counts || {}), slices: 0, ...parseObject(job.result) };
  counts.slices += 1;
  const room = () =>
    ctx.used.queries + USER_RESERVE.queries <= ctx.lim.queries && ctx.used.fetches + USER_RESERVE.fetches <= ctx.lim.fetches;
  ctx.resume = job.cursor || null;
  ctx.cursor = null;
  let status = 'done';
  let error = null;
  try {
    const r = await def.run(ctx, counts, room);
    status = r?.status || 'done';
    error = r?.error || null;
  } catch (e) {
    status = 'error';
    error = String(e?.message || e).slice(0, 500);
    console.error('jobs: failed', job.name, e);
  }
  await ctx.db.run('UPDATE jobs SET status = ?, cursor = ?, result = ?, error = ?, finished_at = ? WHERE name = ?', [
    status,
    status === 'done' ? null : ctx.cursor,
    JSON.stringify(counts),
    error,
    status === 'partial' ? null : new Date(ctx.nowMs).toISOString(),
    job.name,
  ]);
  return { ran: job.name, status, result: counts, error };
}

// ---- admin view ----

function intervalNext(j, nowMs) {
  if (intervalDue(j, nowMs)) return { dueNow: true };
  if (j.status === 'running' || !j.finished_at) return null;
  return { dueNow: false, at: new Date(new Date(j.finished_at).getTime() + JOBS[j.name].everyMinutes * 60e3).toISOString() };
}

export async function jobsStatus(db, env) {
  const nowMs = clock(env);
  const settings = await getSettings(db);
  const tz = workspaceTz(settings);
  const parts = localParts(nowMs, tz);
  const jobs = await loadJobs(db);
  return {
    timeZone: tz,
    localNow: `${parts.date} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`,
    auto: String(env.JOBS_AUTO || '').toLowerCase() !== 'off',
    secretConfigured: Boolean(env.JOBS_SECRET),
    jobs: jobs.map((j) => {
      const result = parseJson(j.result);
      return {
        name: j.name,
        label: JOBS[j.name].label,
        weekly: JOBS[j.name].weekly,
        everyMinutes: JOBS[j.name].everyMinutes || null,
        hour: Number(j.hour),
        weekday: j.weekday === null || j.weekday === undefined ? null : Number(j.weekday),
        enabled: Boolean(Number(j.enabled)),
        lastRunOn: j.last_run_on,
        startedAt: j.started_at,
        finishedAt: j.finished_at,
        status: j.status,
        result,
        error: j.error,
        next: !Number(j.enabled)
          ? null
          : JOBS[j.name].everyMinutes
            ? intervalNext(j, nowMs)
            : nextRun({ ...j, hour: Number(j.hour), enabled: true }, parts),
      };
    }),
  };
}
