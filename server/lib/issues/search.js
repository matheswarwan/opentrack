// Issue search: the WHERE clause from query parameters (issueFilter) and the one list query (searchIssues).
import { visibleProjectsSql } from '../access.js';
import { withFields, fieldConditions } from '../customFields.js';
import { withReleases, releaseConditions } from '../releases.js';
import { ISSUE_SELECT, ISSUE_FROM, withLabels } from './model.js';
import { OPEN_BLOCKER_SQL, withBlocked } from './links.js';
import { placeholders, notDeleted } from '../../db/sql.js';

const PRIORITY_SQL = `CASE i.priority WHEN 'highest' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END`;

const list = (v) =>
  v === undefined || v === null || v === ''
    ? []
    : String(v)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

/**
 * Build the issue search from query parameters: { from, where, params }. `from` is ISSUE_FROM, the tables and
 * aliases the conditions are written against, so a caller writes `SELECT ... ${f.from} WHERE ${f.where}`.
 */
export function issueFilter(user, q) {
  const v = visibleProjectsSql(user);
  const where = [notDeleted('i'), v.sql];
  const params = [...v.params];
  const add = (sql, ...p) => {
    where.push(sql);
    params.push(...p);
  };
  const inList = (col, values) => add(`${col} IN (${placeholders(values.length)})`, ...values);

  if (q.archived !== '1') add('p.archived = 0');
  const projects = list(q.project).map((k) => k.toUpperCase());
  if (projects.length) inList('p.key', projects);
  if (list(q.status).length) inList('i.status_id', list(q.status));
  if (list(q.statusName).length)
    add(`LOWER(s.name) IN (${placeholders(list(q.statusName).length)})`, ...list(q.statusName).map((x) => x.toLowerCase()));
  if (list(q.category).length) inList('s.category', list(q.category));
  if (list(q.type).length) inList('i.type', list(q.type));
  if (list(q.priority).length) inList('i.priority', list(q.priority));
  for (const [param, col] of [
    ['assignee', 'i.assignee_id'],
    ['reporter', 'i.reporter_id'],
  ]) {
    const vals = list(q[param]).map((x) => (x === 'me' ? user.id : x));
    if (!vals.length) continue;
    const ids = vals.filter((x) => x !== 'unassigned');
    const parts = [];
    if (ids.length) parts.push(`${col} IN (${placeholders(ids.length)})`);
    if (vals.includes('unassigned')) parts.push(`${col} IS NULL`);
    add(`(${parts.join(' OR ')})`, ...ids);
  }
  const labels = list(q.label);
  if (labels.length)
    add(`EXISTS (SELECT 1 FROM issue_labels l WHERE l.issue_id = i.id AND l.label IN (${placeholders(labels.length)}))`, ...labels);
  if (q.sprint === 'backlog') add('i.sprint_id IS NULL');
  else if (q.sprint === 'active') add(`sp.state = 'active'`);
  else if (q.sprint === 'open') add(`(i.sprint_id IS NULL OR sp.state <> 'closed')`);
  else if (q.sprint) inList('i.sprint_id', list(q.sprint));
  if (q.parent) add('pi.key = ?', String(q.parent).toUpperCase());
  if (q.noSubtasks === '1') add(`i.type <> 'subtask'`);
  if (q.watching === '1') add('EXISTS (SELECT 1 FROM watchers w WHERE w.issue_id = i.id AND w.user_id = ?)', user.id);
  if (q.updatedSince) add('i.updated_at >= ?', String(q.updatedSince));
  if (q.blocked === '1') add(`EXISTS (SELECT 1 ${OPEN_BLOCKER_SQL} AND bl.target_id = i.id)`);
  if (q.dueBefore) add('i.due_date IS NOT NULL AND i.due_date <= ?', String(q.dueBefore));
  for (const cond of fieldConditions(q)) add(cond.sql, ...cond.params); // custom fields: cf.<id>=value, cf.<id>.empty=1
  for (const cond of releaseConditions(q)) add(cond.sql, ...cond.params); // component=, fixVersion= (ids, names or none)
  if (q.q) {
    const text = String(q.q).trim();
    if (/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(text)) add('i.key = ?', text.toUpperCase());
    else {
      const like = `%${text.toLowerCase().replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      add(
        `(LOWER(i.title) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(i.description, '')) LIKE ? ESCAPE '\\' OR LOWER(i.key) LIKE ? ESCAPE '\\')`,
        like,
        like,
        like,
      );
    }
  }
  return { from: ISSUE_FROM, where: where.join(' AND '), params };
}

const SORTS = {
  rank: 'i.rank',
  updated: 'i.updated_at',
  created: 'i.created_at',
  priority: PRIORITY_SQL,
  key: 'p.key, i.number',
  due: 'i.due_date',
  status: 's.position',
  title: 'LOWER(i.title)',
};

// opts.blocked = false: leave out the blocked fields (exports that do not show them save the extra queries).
export async function searchIssues(db, user, q, opts = {}) {
  const f = issueFilter(user, q);
  const sort = SORTS[q.sort] ? q.sort : 'updated';
  const dir =
    q.dir === 'asc'
      ? 'ASC'
      : q.dir === 'desc'
        ? 'DESC'
        : sort === 'rank' || sort === 'priority' || sort === 'key' || sort === 'due' || sort === 'status' || sort === 'title'
          ? 'ASC'
          : 'DESC';
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 1000);
  const offset = Math.max(Number(q.offset) || 0, 0);
  const order = SORTS[sort]
    .split(',')
    .map((col) => `${col.trim()} ${dir}`)
    .join(', ');
  const [rows, total] = await Promise.all([
    db.all(`${ISSUE_SELECT} WHERE ${f.where} ORDER BY ${order}, i.created_at DESC LIMIT ? OFFSET ?`, [...f.params, limit, offset]),
    db.get(`SELECT CAST(COUNT(*) AS INTEGER) AS n ${f.from} WHERE ${f.where}`, f.params),
  ]);
  const issues = await withLabels(db, rows);
  if (opts.blocked !== false) await withBlocked(db, user, issues);
  if (q.withReleases === '1' || opts.releases) await withReleases(db, issues); // components and fix versions, on request
  let fieldDefs = null;
  if (q.withFields === '1' || opts.fields) fieldDefs = (await withFields(db, issues, { text: opts.fields === 'text' })).fields; // custom fields, on request
  return { issues, total: total.n, limit, offset, ...(opts.fields ? { fieldDefs } : {}) };
}

/** CSV columns for the custom fields of the projects in a search result (name, plus the project key when several). */
export function csvFieldColumns(res) {
  const order = [...new Set(res.issues.map((i) => i.projectId))];
  const withAny = order.filter((pid) => res.fieldDefs?.get(pid)?.length);
  return withAny.flatMap((pid) =>
    res.fieldDefs.get(pid).map((f) => ({
      id: f.id,
      header: withAny.length > 1 ? `${f.name} (${res.issues.find((i) => i.projectId === pid).projectKey})` : f.name,
    })),
  );
}
