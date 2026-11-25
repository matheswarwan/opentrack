// Jira Cloud import. The admin page drives a run with POST /api/admin/jira-import/:id/step until it is done;
// every step does a bounded slice of work and saves where it stopped, because one Worker request cannot
// import thousands of issues (D1 on the free plan allows about 50 queries and 50 fetches per request).
//
// Stages (imports.stage):
//   fields     find the custom field ids for story points and sprints (/rest/api/3/field)
//   scan       per project: statuses, boards and sprints, then every issue with light fields: counts, people,
//              attachments over 10 MB. A dry run stops here (status 'ready').
//   users      match Jira people to users (email, else a unique name); optionally create invited users
//   project    per project: create the project with Jira's statuses (category from statusCategory)
//   sprints    per project: sprints of the project's scrum boards
//   issues     per project: issues in key order with comments, work logs, links and pending attachments
//   parents    set parents that were imported after their children
//   attachments  download files of 10 MB or less into the attachment store
//   finish     final report; the Jira credentials are deleted
//
// Idempotent: jira_import_map records every Jira object that was written. An issue's map row is the first
// statement of its batch (no ON CONFLICT), so a repeated issue fails as a whole and is skipped.
// Credentials stay in jira_imports only while the run needs them (deleted on finish, cancel or error).
//
// This file runs a slice (runStep) and saves it. The parts: jira/map.js (value mapping, people), jira/client.js
// (the Jira REST client), jira/stages.js (the stages) and jira/importIssue.js (one issue).
import { uuid, now as nowIso } from './crypto.js';
import { audit } from './audit.js';
import { clock } from './time.js';
import { parseJson as j } from './json.js';
import { MAX_LISTED, insertRows } from './jira/map.js';
import { JiraError, jiraClient } from './jira/client.js';
import { STAGE_FNS } from './jira/stages.js';

const STALE_CREDENTIALS_MS = 24 * 3600e3; // an unfinished run left alone this long loses its credentials
const LEASE_MS = 120e3;

function limits(env, db) {
  const big = db.dialect === 'postgres';
  return {
    queries: Number(env.JIRA_IMPORT_MAX_QUERIES) || (big ? 3000 : 40),
    fetches: Number(env.JIRA_IMPORT_MAX_FETCHES) || (big ? 400 : 40),
    pageSize: Math.min(Math.max(Number(env.JIRA_IMPORT_PAGE_SIZE) || 50, 1), 100),
  };
}

function countingDb(db, used) {
  const count = (n) => (used.queries += n);
  return {
    dialect: db.dialect,
    all: (s, p) => (count(1), db.all(s, p)),
    get: (s, p) => (count(1), db.get(s, p)),
    run: (s, p) => (count(1), db.run(s, p)),
    batch: (st) => (count(Math.max(1, st.length)), db.batch(st)),
  };
}

function emptyProgress() {
  return {
    projects: 0,
    statuses: 0,
    sprints: 0,
    issues: 0,
    comments: 0,
    worklogs: 0,
    links: 0,
    attachments: 0,
    attachmentsSkipped: 0,
    usersCreated: 0,
    parents: 0,
    errors: 0,
    perProject: {},
  };
}

/** Public shape of an import row: never the credentials. */
export function importOut(r, errors) {
  return {
    id: r.id,
    site: r.site,
    jiraUser: r.jira_user,
    status: r.status,
    mode: r.mode,
    stage: r.stage,
    plan: j(r.plan, null),
    options: j(r.options, null),
    jiraProjects: j(r.state, {}).jiraProjects || [],
    progress: j(r.progress, null),
    dryRun: j(r.dry_run, null),
    report: j(r.report, null),
    error: r.error,
    retryAt: r.retry_after,
    hasCredentials: Boolean(r.jira_token),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at,
    ...(errors ? { errors } : {}),
  };
}

/** Delete the credentials of runs that were left unfinished for a day. */
export async function expireStaleCredentials(db, nowMs) {
  const before = new Date(nowMs - STALE_CREDENTIALS_MS).toISOString();
  await db.run(`UPDATE jira_imports SET jira_email = NULL, jira_token = NULL WHERE jira_token IS NOT NULL AND updated_at < ?`, [before]);
}

/**
 * Run one slice of an import. Returns { ran, busy, waiting }.
 * c: the Hono context (env.db, env.fetch, env.now), user: the admin driving the run.
 */
export async function runStep(c, id, user) {
  const used = { queries: 0, fetches: 0 };
  const env = c.env;
  const db = countingDb(env.db, used);
  const lim = limits(env, env.db);
  const nowMs = clock(env);
  const leaseUntil = new Date(nowMs + LEASE_MS).toISOString();
  const took = await db.run(
    `UPDATE jira_imports SET lease_until = ? WHERE id = ? AND status IN ('running', 'waiting') AND (lease_until IS NULL OR lease_until < ?)`,
    [leaseUntil, id, new Date(nowMs).toISOString()],
  );
  if (took.changes !== 1) return { ran: false, busy: true };
  const row = await db.get('SELECT * FROM jira_imports WHERE id = ?', [id]);
  if (row.retry_after && new Date(row.retry_after).getTime() > nowMs) {
    await db.run('UPDATE jira_imports SET lease_until = NULL WHERE id = ?', [id]);
    return { ran: false, waiting: true };
  }

  const ctx = {
    c,
    env,
    db,
    lim,
    used,
    user,
    nowMs,
    imp: row,
    status: 'running',
    stage: row.stage,
    mode: row.mode,
    plan: j(row.plan, { projects: [] }),
    options: j(row.options, {}),
    state: j(row.state, {}),
    progress: j(row.progress, null) || emptyProgress(),
    people: j(row.people, {}),
    dryRun: j(row.dry_run, null),
    errors: [],
    units: 0,
    error: null,
    retryAfter: null,
    jira: jiraClient({ fetch: env.fetch || ((...a) => fetch(...a)), site: row.site, email: row.jira_email, token: row.jira_token, used }),
  };
  if (!row.jira_token) {
    ctx.status = 'error';
    ctx.error = 'The Jira credentials are gone (the run was left for more than a day). Start a new import.';
  }

  try {
    while (ctx.status === 'running') {
      if (ctx.units > 0 && outOfBudget(ctx)) break;
      await STAGE_FNS[ctx.stage](ctx);
      ctx.units += 1;
    }
    ctx.state.failures = 0;
  } catch (e) {
    if (e instanceof JiraError && e.status === 429) {
      ctx.status = 'waiting';
      ctx.retryAfter = new Date(nowMs + e.retryAfter * 1000).toISOString();
      ctx.progress.rateLimited = (ctx.progress.rateLimited || 0) + 1;
    } else if (e instanceof JiraError && (e.status === 0 || e.status >= 500) && (ctx.state.failures || 0) < 5) {
      ctx.state.failures = (ctx.state.failures || 0) + 1;
      ctx.status = 'waiting';
      ctx.retryAfter = new Date(nowMs + 15e3).toISOString();
      ctx.errors.push({ stage: ctx.stage, key: null, message: `${e.message} (will try again)` });
    } else {
      ctx.status = 'error';
      ctx.error = e instanceof JiraError ? `Jira: ${e.message}` : `Import stopped: ${e?.message || e}`;
      if (!(e instanceof JiraError)) console.error('jira import', e);
    }
  }
  return save(ctx);
}

/** Room for another unit of the current stage? */
function outOfBudget(ctx) {
  const o = ctx.options;
  const need = {
    scan: { q: 2, f: 4 },
    issues: { q: 16, f: 1 + (o.comments ? 1 : 0) + (o.worklogs ? 1 : 0) },
    attachments: { q: 20, f: 1 },
    sprints: { q: 6, f: 2 },
    project: { q: 10, f: 2 },
  }[ctx.stage] || { q: 6, f: 1 };
  return ctx.used.queries + need.q + 3 > ctx.lim.queries || ctx.used.fetches + need.f > ctx.lim.fetches;
}

async function save(ctx) {
  const { imp } = ctx;
  const t = nowIso();
  const terminal = ['done', 'cancelled', 'error', 'ready'].includes(ctx.status);
  const ended = ['done', 'cancelled', 'error'].includes(ctx.status);
  const stmts = [];
  if (ctx.errors.length) {
    ctx.progress.errors += ctx.errors.filter((e) => !e.message.endsWith('(will try again)')).length;
    stmts.push(
      ...insertRows(
        'jira_import_errors',
        ['id', 'import_id', 'stage', 'jira_key', 'message', 'created_at'],
        ctx.errors.map((e) => [uuid(), imp.id, e.stage, e.key, String(e.message).slice(0, 1000), t]),
      ),
    );
  }
  if (ctx.status === 'done') ctx.report = buildReport(ctx);
  stmts.push({
    sql: `UPDATE jira_imports SET status = ?, stage = ?, state = ?, progress = ?, people = ?, dry_run = ?, report = COALESCE(?, report), error = ?,
          retry_after = ?, lease_until = NULL, updated_at = ?, finished_at = ?,
          jira_email = CASE WHEN ? = 1 THEN NULL ELSE jira_email END, jira_token = CASE WHEN ? = 1 THEN NULL ELSE jira_token END
          WHERE id = ? AND status <> 'cancelled'`,
    params: [
      ctx.status,
      ctx.stage,
      JSON.stringify(ctx.state),
      JSON.stringify(ctx.progress),
      JSON.stringify(ctx.people),
      ctx.dryRun ? JSON.stringify(ctx.dryRun) : null,
      ctx.report ? JSON.stringify(ctx.report) : null,
      ctx.error,
      ctx.retryAfter,
      t,
      ended ? t : null,
      ended ? 1 : 0,
      ended ? 1 : 0,
      imp.id,
    ],
  });
  if (ctx.status === 'done')
    stmts.push(audit(ctx.user.id, 'jira_import.finished', 'jira_import', imp.id, { site: imp.site, ...pickCounts(ctx.progress) }));
  if (ctx.status === 'error')
    stmts.push(audit(ctx.user.id, 'jira_import.failed', 'jira_import', imp.id, { site: imp.site, error: ctx.error }));
  await ctx.env.db.batch(stmts);
  return { ran: true, status: ctx.status, terminal };
}

const pickCounts = (p) => ({
  projects: p.projects,
  issues: p.issues,
  comments: p.comments,
  sprints: p.sprints,
  links: p.links,
  attachments: p.attachments,
  errors: p.errors,
});

function buildReport(ctx) {
  const people = Object.values(ctx.people);
  return {
    ...pickCounts(ctx.progress),
    statuses: ctx.progress.statuses,
    worklogs: ctx.progress.worklogs,
    attachmentsSkipped: ctx.progress.attachmentsSkipped,
    usersCreated: ctx.progress.usersCreated,
    perProject: ctx.plan.projects.map((p) => ({
      jiraKey: p.jiraKey,
      targetKey: p.targetKey,
      keptNumbers: p.jiraKey === p.targetKey,
      ...(ctx.progress.perProject[p.jiraKey] || {}),
    })),
    unmatched: people
      .filter((p) => !p.userId)
      .slice(0, MAX_LISTED)
      .map((p) => ({ name: p.name, email: p.email })),
  };
}
