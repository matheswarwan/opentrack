// Components and releases (fix versions): the helpers the issue routes, search, exports, imports, reports and
// templates use. Tables: components + issue_components, releases + issue_releases (migrations/0018_releases.sql).
//
// The API takes components and fix versions as lists of ids or names (names match case-insensitively within the
// issue's project). Issue payloads show components: [{ id, name }] and fixVersions: [{ id, name, status, releaseDate }].
// Search: component=<id or name>,none and fixVersion=<id or name>,none (several values match any of them).
import { fail } from './http.js';
import { historyStmt } from './history.js';
import { placeholders, chunks } from '../db/sql.js';

export const RELEASE_STATUSES = ['unreleased', 'released', 'archived'];
export const MAX_COMPONENTS = 100; // per project
export const MAX_RELEASES = 200; // per project
const MAX_PER_ISSUE = 20;

// kind -> tables and columns
export const KINDS = {
  components: { table: 'components', join: 'issue_components', col: 'component_id', label: 'Component', history: 'components' },
  fixVersions: { table: 'releases', join: 'issue_releases', col: 'release_id', label: 'Fix version', history: 'fix_versions' },
};

export function componentOut(r, extra = {}) {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    description: r.description || '',
    lead: r.lead_id ? { id: r.lead_id, name: r.lead_name || 'Former user' } : null,
    defaultAssignee: r.default_assignee_id ? { id: r.default_assignee_id, name: r.default_name || 'Former user' } : null,
    ...extra,
  };
}

/** day: today (YYYY-MM-DD) for the reader, used for the overdue flag. */
export function releaseOut(r, progress, day) {
  const p = progress || { total: 0, done: 0, points: 0, pointsDone: 0, inProgress: 0 };
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    description: r.description || '',
    startDate: r.start_date || null,
    releaseDate: r.release_date || null,
    status: r.status,
    releasedAt: r.released_at || null,
    overdue: r.status === 'unreleased' && Boolean(r.release_date) && r.release_date < day,
    progress: p,
  };
}

/** Components of a project with lead and default assignee names, by name. */
export async function listComponents(db, projectId) {
  return db.all(
    `SELECT c.*, l.name AS lead_name, d.name AS default_name FROM components c
       LEFT JOIN users l ON l.id = c.lead_id LEFT JOIN users d ON d.id = c.default_assignee_id
      WHERE c.project_id = ? ORDER BY LOWER(c.name)`,
    [projectId],
  );
}

/** Progress of releases: Map releaseId -> { total, done, inProgress, points, pointsDone }. Issues in the Trash are left out. */
export async function releaseProgress(db, projectId, releaseId = null) {
  const rows = await db.all(
    `SELECT ir.release_id, s.category, CAST(COUNT(*) AS INTEGER) AS n, CAST(SUM(COALESCE(i.story_points, 0)) AS DOUBLE PRECISION) AS pts
       FROM issue_releases ir JOIN releases r ON r.id = ir.release_id JOIN issues i ON i.id = ir.issue_id JOIN statuses s ON s.id = i.status_id
      WHERE r.project_id = ? AND i.deleted_at IS NULL${releaseId ? ' AND r.id = ?' : ''}
      GROUP BY ir.release_id, s.category`,
    releaseId ? [projectId, releaseId] : [projectId],
  );
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.release_id)) out.set(r.release_id, { total: 0, done: 0, inProgress: 0, points: 0, pointsDone: 0 });
    const p = out.get(r.release_id);
    const n = Number(r.n);
    const pts = Number(r.pts) || 0;
    p.total += n;
    p.points = Math.round((p.points + pts) * 10) / 10;
    if (r.category === 'done') {
      p.done += n;
      p.pointsDone = Math.round((p.pointsDone + pts) * 10) / 10;
    } else if (r.category === 'in_progress') p.inProgress += n;
  }
  return out;
}

/** Releases of a project in display order: unreleased (by release date, then name), released (newest first), archived. */
export async function listReleases(db, projectId) {
  const rows = await db.all('SELECT * FROM releases WHERE project_id = ?', [projectId]);
  const rank = { unreleased: 0, released: 1, archived: 2 };
  return rows.sort((a, b) => {
    if (a.status !== b.status) return rank[a.status] - rank[b.status];
    if (a.status === 'unreleased')
      return (a.release_date || '9999').localeCompare(b.release_date || '9999') || a.name.localeCompare(b.name);
    return (b.released_at || b.release_date || '').localeCompare(a.released_at || a.release_date || '') || a.name.localeCompare(b.name);
  });
}

/** Light lists for the project payload (pickers): components and releases. */
export async function projectReleaseLists(db, projectId) {
  const [components, releases] = await Promise.all([listComponents(db, projectId), listReleases(db, projectId)]);
  return {
    components: components.map((c) => ({ id: c.id, name: c.name, defaultAssigneeId: c.default_assignee_id || null })),
    releases: releases.map((r) => ({ id: r.id, name: r.name, status: r.status, releaseDate: r.release_date || null })),
  };
}

/**
 * Attach components and fixVersions to issue payloads (two queries per 80 issues). Order: by name; fix versions
 * by release date.
 */
export async function withReleases(db, issues) {
  if (!issues.length) return issues;
  const comps = new Map();
  const vers = new Map();
  for (const part of chunks(issues.map((i) => i.id))) {
    const ph = placeholders(part.length);
    const [c, v] = await Promise.all([
      db.all(
        `SELECT ic.issue_id, c.id, c.name FROM issue_components ic JOIN components c ON c.id = ic.component_id WHERE ic.issue_id IN (${ph}) ORDER BY LOWER(c.name)`,
        part,
      ),
      db.all(
        `SELECT ir.issue_id, r.id, r.name, r.status, r.release_date FROM issue_releases ir JOIN releases r ON r.id = ir.release_id WHERE ir.issue_id IN (${ph}) ORDER BY r.release_date, LOWER(r.name)`,
        part,
      ),
    ]);
    for (const r of c) {
      if (!comps.has(r.issue_id)) comps.set(r.issue_id, []);
      comps.get(r.issue_id).push({ id: r.id, name: r.name });
    }
    for (const r of v) {
      if (!vers.has(r.issue_id)) vers.set(r.issue_id, []);
      vers.get(r.issue_id).push({ id: r.id, name: r.name, status: r.status, releaseDate: r.release_date || null });
    }
  }
  for (const i of issues) {
    i.components = comps.get(i.id) || [];
    i.fixVersions = vers.get(i.id) || [];
  }
  return issues;
}

/** Current ids of an issue: kind 'components' or 'fixVersions'. */
export async function currentIds(db, issueId, kind) {
  const k = KINDS[kind];
  return (await db.all(`SELECT ${k.col} AS id FROM ${k.join} WHERE issue_id = ?`, [issueId])).map((r) => r.id);
}

function asList(input, label) {
  if (input === null) return [];
  if (typeof input === 'string')
    return input
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  if (!Array.isArray(input)) fail(400, `${label} must be a list`);
  return input
    .map((x) => {
      if (typeof x !== 'string' && typeof x !== 'number') fail(400, `${label} must be a list of ids or names`);
      return String(x).trim();
    })
    .filter(Boolean);
}

/**
 * Turn a list of ids or names into rows of `kind` in the project. Unknown values fail, unless opts.missing is an
 * array (they are collected there instead). Archived releases cannot be picked unless already set (opts.current).
 */
export async function resolveIds(db, projectId, kind, input, opts = {}) {
  const k = KINDS[kind];
  const list = [...new Set(asList(input, kind === 'components' ? 'components' : 'fixVersions'))];
  if (list.length > MAX_PER_ISSUE) fail(400, `At most ${MAX_PER_ISSUE} ${kind === 'components' ? 'components' : 'fix versions'} per issue`);
  if (!list.length) return [];
  const rows = await db.all(
    `SELECT * FROM ${k.table} WHERE project_id = ? AND (id IN (${placeholders(list.length)}) OR LOWER(name) IN (${placeholders(list.length)}))`,
    [projectId, ...list, ...list.map((x) => x.toLowerCase())],
  );
  const out = [];
  for (const v of list) {
    const r = rows.find((x) => x.id === v) || rows.find((x) => x.name.toLowerCase() === v.toLowerCase());
    if (!r) {
      if (Array.isArray(opts.missing)) {
        opts.missing.push(v);
        continue;
      }
      fail(400, `${k.label} not found: ${v}`);
    }
    if (kind === 'fixVersions' && !opts.remove && r.status === 'archived' && !(opts.current || []).includes(r.id))
      fail(400, `The release "${r.name}" is archived`);
    if (!out.some((x) => x.id === r.id)) out.push(r);
  }
  return out;
}

/** Statements that add components and fix versions to a new issue. */
export function releaseInsertStmts(issueId, componentIds = [], releaseIds = []) {
  return [
    ...componentIds.map((id) => ({ sql: 'INSERT INTO issue_components (issue_id, component_id) VALUES (?, ?)', params: [issueId, id] })),
    ...releaseIds.map((id) => ({ sql: 'INSERT INTO issue_releases (issue_id, release_id) VALUES (?, ?)', params: [issueId, id] })),
  ];
}

/** The default assignee of the first component (in the given order) that has an active one, or null. */
export async function defaultAssignee(db, componentRows) {
  const ids = componentRows.map((c) => c.default_assignee_id).filter(Boolean);
  if (!ids.length) return null;
  const users = await db.all(`SELECT id, name FROM users WHERE status <> 'deactivated' AND id IN (${placeholders(ids.length)})`, ids);
  for (const id of ids) {
    const u = users.find((x) => x.id === id);
    if (u) return u;
  }
  return null;
}

/** Names of rows by id, joined for history ("API, UI"). */
const namesText = (rows) =>
  rows.length
    ? rows
        .map((r) => r.name)
        .sort((a, b) => a.localeCompare(b))
        .join(', ')
    : null;

/**
 * Changes to an issue's components and fix versions from a PATCH body ({ components, fixVersions }: lists of ids or
 * names, replacing the old ones). Returns { stmts, history, assignee } where assignee is the default assignee of a
 * newly added component (the caller assigns them when the issue ends up with no assignee).
 */
export async function releaseChangeSet(db, issue, b) {
  const stmts = [];
  const history = [];
  let assignee = null;
  for (const kind of ['components', 'fixVersions']) {
    if (b[kind] === undefined) continue;
    const k = KINDS[kind];
    const cur = await currentIds(db, issue.id, kind);
    const next = await resolveIds(db, issue.project_id, kind, b[kind], { current: cur });
    const nextIds = next.map((r) => r.id);
    const added = nextIds.filter((id) => !cur.includes(id));
    const removed = cur.filter((id) => !nextIds.includes(id));
    if (!added.length && !removed.length) continue;
    const before = cur.length ? await db.all(`SELECT id, name FROM ${k.table} WHERE id IN (${placeholders(cur.length)})`, cur) : [];
    for (const id of removed) stmts.push({ sql: `DELETE FROM ${k.join} WHERE issue_id = ? AND ${k.col} = ?`, params: [issue.id, id] });
    for (const id of added)
      stmts.push({ sql: `INSERT INTO ${k.join} (issue_id, ${k.col}) VALUES (?, ?) ON CONFLICT DO NOTHING`, params: [issue.id, id] });
    history.push([k.history, namesText(before), namesText(next)]);
    if (kind === 'components' && added.length)
      assignee = await defaultAssignee(
        db,
        next.filter((r) => added.includes(r.id)),
      );
  }
  return { stmts, history, assignee };
}

/**
 * Bulk add/remove: the full lists for one issue from { addComponents, removeComponents, addFixVersions, removeFixVersions }
 * (ids or names). Values to remove that do not exist are ignored. Returns a PATCH body part.
 */
export async function bulkLists(db, issue, ch) {
  const out = {};
  for (const [kind, add, remove] of [
    ['components', ch.addComponents, ch.removeComponents],
    ['fixVersions', ch.addFixVersions, ch.removeFixVersions],
  ]) {
    if (add === undefined && remove === undefined) continue;
    const cur = await currentIds(db, issue.id, kind);
    const plus = add === undefined ? [] : (await resolveIds(db, issue.project_id, kind, add, { current: cur })).map((r) => r.id);
    const minus =
      remove === undefined
        ? []
        : (await resolveIds(db, issue.project_id, kind, remove, { missing: [], current: cur, remove: true })).map((r) => r.id);
    out[kind] = [...new Set([...cur, ...plus])].filter((id) => !minus.includes(id));
  }
  return out;
}

/**
 * Search conditions (alias i = issues): component=<ids or names>,none and fixVersion=<ids or names>,none.
 * 'none' matches issues without any; other values match issues with any of them.
 */
export function releaseConditions(q) {
  const out = [];
  for (const [param, kind] of [
    ['component', 'components'],
    ['fixVersion', 'fixVersions'],
  ]) {
    const raw = q?.[param];
    if (raw === undefined || raw === null || raw === '') continue;
    const vals = [
      ...new Set(
        String(raw)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ].slice(0, 20);
    if (!vals.length) continue;
    const k = KINDS[kind];
    const named = vals.filter((v) => v.toLowerCase() !== 'none');
    const parts = [];
    const params = [];
    if (named.length) {
      parts.push(`EXISTS (SELECT 1 FROM ${k.join} xj JOIN ${k.table} xt ON xt.id = xj.${k.col} WHERE xj.issue_id = i.id
        AND (xt.id IN (${placeholders(named.length)}) OR LOWER(xt.name) IN (${placeholders(named.length)})))`);
      params.push(...named, ...named.map((v) => v.toLowerCase()));
    }
    if (named.length < vals.length) parts.push(`NOT EXISTS (SELECT 1 FROM ${k.join} xj WHERE xj.issue_id = i.id)`);
    out.push({ sql: `(${parts.join(' OR ')})`, params });
  }
  return out;
}

// ---------- release notes ----------

const SECTIONS = [
  { title: 'Features', types: ['epic', 'story'] },
  { title: 'Improvements', types: ['task'] },
  { title: 'Bug fixes', types: ['bug'] },
];

/** Markdown release notes: done issues grouped by type (sub-tasks left out, they belong to their parents). */
export function releaseNotes(project, release, issues, origin = '') {
  const done = issues.filter((i) => i.status.category === 'done' && i.type !== 'subtask');
  const open = issues.filter((i) => i.status.category !== 'done' && i.type !== 'subtask').length;
  const lines = [`# ${project.name} ${release.name}`, ''];
  if (release.status === 'released') lines.push(`Released ${release.releaseDate || (release.releasedAt || '').slice(0, 10)}.`);
  else if (release.releaseDate) lines.push(`Planned release date: ${release.releaseDate}. Not released yet.`);
  else lines.push('Not released yet.');
  if (release.description) lines.push('', release.description);
  for (const s of SECTIONS) {
    const list = done.filter((i) => s.types.includes(i.type));
    if (!list.length) continue;
    lines.push('', `## ${s.title}`, '');
    for (const i of list) lines.push(`- ${origin ? `[${i.key}](${origin}/browse/${i.key})` : i.key} ${i.title.replace(/\s+/g, ' ')}`);
  }
  if (!done.length) lines.push('', 'No finished issues in this release yet.');
  if (open) lines.push('', `${open} issue${open === 1 ? ' is' : 's are'} not done and ${open === 1 ? 'is' : 'are'} not listed.`);
  return `${lines.join('\n')}\n`;
}

export const notesFilename = (project, release) => `${project.key}-${release.name}-release-notes.md`.replace(/[^A-Za-z0-9._-]+/g, '-');

/** History statements for many issues at once. rows: [issueId, field, old, new]. */
export function historyStmts(actorId, t, rows, source = null) {
  return rows.map(([issueId, field, o, n]) => historyStmt(issueId, actorId, field, o, n, t, source));
}
