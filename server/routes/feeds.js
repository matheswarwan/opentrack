// Google Sheets feeds: secret CSV URLs (/feeds/<token>.csv) that Sheets pulls with =IMPORTDATA("<url>").
// A feed is a saved issue search plus a column list. It runs as its owner with the owner's CURRENT
// permissions (the normal search code), so a private project the owner leaves drops out of the feed.
// Only the token's SHA-256 is stored. Revoked feeds, deactivated owners and the admin setting
// sheetFeeds = false all give 404.
import { body, fail, str } from '../lib/http.js';
import { uuid, now, randomToken, sha256 } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { getSettings } from '../lib/settings.js';
import { searchIssues } from '../lib/issues/search.js';
import { publicOrigin } from '../lib/http.js';
import { visibleProjectsSql, projectAccess } from '../lib/access.js';
import { copyFieldQuery, visibleField, listFields, withFields, FIELD_ID_RE } from '../lib/customFields.js';
import { withReleases } from '../lib/releases.js';
import { placeholders, chunks } from '../db/sql.js';
import { csvCell } from '../lib/csv.js';
import { parseJson } from '../lib/json.js';

export const MAX_ROWS = 5000;
const MAX_FEEDS = 25; // per person
const PAGE = 1000; // searchIssues returns at most 1000 at a time

// Search parameters a feed may keep (same names as GET /api/issues).
const QUERY_KEYS = [
  'q',
  'project',
  'type',
  'category',
  'status',
  'statusName',
  'priority',
  'assignee',
  'reporter',
  'label',
  'sprint',
  'parent',
  'noSubtasks',
  'watching',
  'archived',
  'updatedSince',
  'dueBefore',
  'blocked',
  'component',
  'fixVersion',
  'sort',
  'dir',
];

export const FEED_COLUMNS = [
  { id: 'key', label: 'Key' },
  { id: 'type', label: 'Type' },
  { id: 'title', label: 'Title' },
  { id: 'status', label: 'Status' },
  { id: 'statusCategory', label: 'Status category' },
  { id: 'priority', label: 'Priority' },
  { id: 'assignee', label: 'Assignee' },
  { id: 'assigneeEmail', label: 'Assignee email' },
  { id: 'reporter', label: 'Reporter' },
  { id: 'epicKey', label: 'Epic key' },
  { id: 'epicTitle', label: 'Epic title' },
  { id: 'parentKey', label: 'Parent key' },
  { id: 'sprint', label: 'Sprint' },
  { id: 'storyPoints', label: 'Story points' },
  { id: 'estimate', label: 'Estimate (hours)' },
  { id: 'loggedHours', label: 'Logged hours' },
  { id: 'dueDate', label: 'Due date' },
  { id: 'labels', label: 'Labels' },
  { id: 'components', label: 'Components' },
  { id: 'fixVersions', label: 'Fix versions' },
  { id: 'created', label: 'Created' },
  { id: 'updated', label: 'Updated' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'url', label: 'URL' },
];
const COLUMN_IDS = FEED_COLUMNS.map((c) => c.id);
export const DEFAULT_COLUMNS = ['key', 'type', 'title', 'status', 'assignee', 'epicKey', 'epicTitle', 'sprint', 'storyPoints', 'dueDate'];

function cleanQuery(q) {
  if (!q || typeof q !== 'object' || Array.isArray(q)) return {};
  const out = {};
  for (const k of QUERY_KEYS) {
    const v = q[k];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' && typeof v !== 'number') fail(400, `query.${k} must be text`);
    const s = String(v).trim();
    if (s.length > 500) fail(400, `query.${k} is too long`);
    if (s) out[k] = s;
  }
  return copyFieldQuery(q, out); // cf.<fieldId> filters
}

// Custom field columns are 'cf:<fieldId>'; the creator must be able to see the field's project.
const isFieldColumn = (c) => c.startsWith('cf:') && FIELD_ID_RE.test(c.slice(3));

async function cleanColumns(db, user, cols) {
  if (cols === undefined) return DEFAULT_COLUMNS;
  if (!Array.isArray(cols) || !cols.length) fail(400, 'Pick at least one column');
  const out = [...new Set(cols.map(String))];
  const bad = out.filter((c) => !COLUMN_IDS.includes(c) && !isFieldColumn(c));
  if (bad.length) fail(400, `Unknown column: ${bad.join(', ')}`);
  const fieldCols = out.filter(isFieldColumn);
  if (fieldCols.length > 20) fail(400, 'At most 20 custom field columns');
  const v = visibleProjectsSql(user);
  for (const col of fieldCols) if (!(await visibleField(db, v, col.slice(3)))) fail(400, `Unknown column: ${col}`);
  return out;
}

function feedOut(f) {
  return {
    id: f.id,
    name: f.name,
    query: parseJson(f.query, {}),
    columns: parseJson(f.columns, DEFAULT_COLUMNS),
    prefix: f.prefix,
    createdAt: f.created_at,
    lastUsedAt: f.last_used_at,
  };
}

/** Rows for a feed: the owner's search, up to MAX_ROWS, plus the extra columns that need lookups. */
async function feedRows(db, owner, query, columns) {
  const issues = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
    const r = await searchIssues(db, owner, { ...query, limit: Math.min(PAGE, MAX_ROWS - offset), offset }, { blocked: false });
    issues.push(...r.issues);
    if (r.issues.length < PAGE) break;
  }
  // custom field columns: only fields the owner can still see; values as plain text
  const fieldNames = new Map();
  const fieldCols = columns.filter(isFieldColumn);
  if (fieldCols.length) {
    const v = visibleProjectsSql(owner);
    for (const col of fieldCols) {
      const f = await visibleField(db, v, col.slice(3));
      if (f) fieldNames.set(col, f.name);
    }
    if (fieldNames.size) await withFields(db, issues, { text: true });
  }
  const need = (c) => columns.includes(c);
  if (need('components') || need('fixVersions')) await withReleases(db, issues);
  // 200 ids per query is over D1's limit of MAX_BOUND bound values (server/db/sql.js); kept as it was, to be checked on D1
  const feedChunks = (ids) => chunks(ids, 200);

  const emails = new Map();
  if (need('assigneeEmail')) {
    const ids = [...new Set(issues.map((i) => i.assignee?.id).filter(Boolean))];
    for (const part of feedChunks(ids)) {
      for (const u of await db.all(`SELECT id, email FROM users WHERE id IN (${placeholders(part.length)})`, part))
        emails.set(u.id, u.email);
    }
  }
  const epics = new Map(); // issue id -> { key, title }
  if (need('epicKey') || need('epicTitle')) {
    // stories, tasks and bugs: the parent is the epic; sub-tasks: the parent's parent
    const grand = [];
    for (const i of issues) {
      if (!i.parent) continue;
      if (i.parent.type === 'epic') epics.set(i.id, { key: i.parent.key, title: i.parent.title });
      else grand.push(i);
    }
    const parentIds = [...new Set(grand.map((i) => i.parent.id))];
    const map = new Map();
    for (const part of feedChunks(parentIds)) {
      const rows = await db.all(
        `SELECT p.id, e.key, e.title FROM issues p JOIN issues e ON e.id = p.parent_id WHERE e.type = 'epic' AND e.deleted_at IS NULL AND p.id IN (${placeholders(part.length)})`,
        part,
      );
      for (const r of rows) map.set(r.id, { key: r.key, title: r.title });
    }
    for (const i of grand) if (map.has(i.parent.id)) epics.set(i.id, map.get(i.parent.id));
  }
  const logged = new Map();
  if (need('loggedHours')) {
    for (const part of feedChunks(issues.map((i) => i.id))) {
      const rows = await db.all(
        `SELECT issue_id, SUM(hours) AS h FROM worklogs WHERE issue_id IN (${placeholders(part.length)}) GROUP BY issue_id`,
        part,
      );
      for (const r of rows) logged.set(r.issue_id, Math.round(Number(r.h) * 100) / 100);
    }
  }
  return { issues, emails, epics, logged, fieldNames };
}

function cellValue(col, i, ctx) {
  switch (col) {
    case 'key':
      return i.key;
    case 'type':
      return i.type;
    case 'title':
      return i.title;
    case 'status':
      return i.status.name;
    case 'statusCategory':
      return i.status.category;
    case 'priority':
      return i.priority;
    case 'assignee':
      return i.assignee?.name;
    case 'assigneeEmail':
      return i.assignee ? ctx.emails.get(i.assignee.id) : '';
    case 'reporter':
      return i.reporter?.name;
    case 'epicKey':
      return ctx.epics.get(i.id)?.key;
    case 'epicTitle':
      return ctx.epics.get(i.id)?.title;
    case 'parentKey':
      return i.parent?.key;
    case 'sprint':
      return i.sprint?.name;
    case 'storyPoints':
      return i.storyPoints;
    case 'estimate':
      return i.estimateHours;
    case 'loggedHours':
      return ctx.logged.get(i.id) ?? 0;
    case 'dueDate':
      return i.dueDate;
    case 'labels':
      return i.labels.join(' ');
    case 'components':
      return (i.components || []).map((x) => x.name).join(', ');
    case 'fixVersions':
      return (i.fixVersions || []).map((x) => x.name).join(', ');
    case 'created':
      return i.createdAt;
    case 'updated':
      return i.updatedAt;
    case 'resolved':
      return i.resolvedAt;
    case 'url':
      return `${ctx.origin}/browse/${i.key}`;
    default:
      return isFieldColumn(col) && ctx.fieldNames.has(col) ? i.fields?.[col.slice(3)] : '';
  }
}

export function registerFeeds(app) {
  app.get('/api/feeds', async (c) => {
    const rows = await c.env.db.all(
      "SELECT * FROM feeds WHERE owner_id = ? AND revoked_at IS NULL AND kind = 'csv' ORDER BY created_at DESC",
      [c.get('user').id],
    );
    const settings = await getSettings(c.env.db);
    // ?project=KEY adds that project's custom fields as columns ('cf:<fieldId>')
    let fieldColumns = [];
    if (c.req.query('project')) {
      const a = await projectAccess(c, c.req.query('project'));
      fieldColumns = (await listFields(c.env.db, a.project.id, { activeOnly: true })).map((f) => ({ id: `cf:${f.id}`, label: f.name }));
    }
    return c.json({
      enabled: settings.sheetFeeds,
      feeds: rows.map(feedOut),
      columns: [...FEED_COLUMNS, ...fieldColumns],
      defaultColumns: DEFAULT_COLUMNS,
      maxRows: MAX_ROWS,
    });
  });

  // Create: { name, query (search params), columns }. The URL is shown once.
  app.post('/api/feeds', async (c) => {
    const db = c.env.db;
    const user = c.get('user');
    if (c.get('authVia') === 'token') fail(403, 'Feeds can only be created in the web app');
    if (!(await getSettings(db)).sheetFeeds) fail(403, 'Google Sheets feeds are turned off by an admin');
    const b = await body(c);
    const name = str(b.name, { required: true, max: 100, name: 'Name' });
    const query = cleanQuery(b.query);
    const columns = await cleanColumns(db, user, b.columns);
    const count = await db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM feeds WHERE owner_id = ? AND revoked_at IS NULL', [user.id]);
    if (count.n >= MAX_FEEDS) fail(400, `You can have at most ${MAX_FEEDS} feeds. Revoke one first.`);
    const token = randomToken(32);
    const id = uuid();
    const t = now();
    await db.batch([
      {
        sql: 'INSERT INTO feeds (id, owner_id, name, query, columns, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        params: [id, user.id, name, JSON.stringify(query), JSON.stringify(columns), await sha256(token), token.slice(0, 6), t],
      },
      audit(user.id, 'feed.created', 'feed', id, { name, query, columns }),
    ]);
    const url = `${publicOrigin(c)}/feeds/${token}.csv`;
    const feed = await db.get('SELECT * FROM feeds WHERE id = ?', [id]);
    return c.json({ feed: feedOut(feed), url, formula: `=IMPORTDATA("${url}")` }, 201);
  });

  app.delete('/api/feeds/:id', async (c) => {
    const db = c.env.db;
    const user = c.get('user');
    const f = await db.get('SELECT id, owner_id, name FROM feeds WHERE id = ? AND revoked_at IS NULL', [c.req.param('id')]);
    if (!f || (f.owner_id !== user.id && user.role !== 'admin')) fail(404, 'Feed not found');
    await db.batch([
      { sql: 'UPDATE feeds SET revoked_at = ? WHERE id = ?', params: [now(), f.id] },
      audit(user.id, 'feed.revoked', 'feed', f.id, { name: f.name, owner: f.owner_id }),
    ]);
    return c.json({ ok: true });
  });

  // Public: the CSV itself. No cookie; the token in the URL is the only key.
  app.get('/feeds/:file', async (c) => {
    const notFound = () => c.text('Feed not found', 404, { 'cache-control': 'no-store' });
    const m = /^([A-Za-z0-9_-]{20,100})\.csv$/.exec(c.req.param('file') || '');
    if (!m) return notFound();
    const db = c.env.db;
    if (!(await getSettings(db)).sheetFeeds) return notFound();
    const feed = await db.get(
      `SELECT f.*, u.id AS uid, u.email, u.name AS owner_name, u.role, u.status
         FROM feeds f JOIN users u ON u.id = f.owner_id WHERE f.token_hash = ? AND f.revoked_at IS NULL AND f.kind = 'csv'`,
      [await sha256(m[1])],
    );
    if (!feed || feed.status !== 'active') return notFound();
    const owner = { id: feed.uid, email: feed.email, name: feed.owner_name, role: feed.role, status: feed.status };
    const query = parseJson(feed.query, {});
    const columns = parseJson(feed.columns, DEFAULT_COLUMNS).filter((col) => COLUMN_IDS.includes(col) || isFieldColumn(col));
    const ctx = await feedRows(db, owner, query, columns);
    ctx.origin = publicOrigin(c);
    const labels = new Map([...FEED_COLUMNS.map((col) => [col.id, col.label]), ...ctx.fieldNames]);
    const shown = columns.filter((col) => !isFieldColumn(col) || ctx.fieldNames.has(col)); // fields the owner can no longer see drop out
    const lines = [shown.map((col) => csvCell(labels.get(col))).join(',')];
    for (const i of ctx.issues) lines.push(shown.map((col) => csvCell(cellValue(col, i, ctx))).join(','));
    // record use at most every 5 minutes
    if (!feed.last_used_at || feed.last_used_at < new Date(Date.now() - 300e3).toISOString()) {
      await db.run('UPDATE feeds SET last_used_at = ? WHERE id = ?', [now(), feed.id]);
    }
    return c.body(`${lines.join('\n')}\n`, 200, {
      'content-type': 'text/csv; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    });
  });
}
