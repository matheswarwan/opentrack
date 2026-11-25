// Calendar: issues on their due date (and start to due as a span) plus sprints, for /calendar and the project
// Calendar tab. Uses issueFilter, so visibility, the Trash, archived projects and guests are handled as in search.
//
//   GET /api/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD&project=KEY[,KEY]&assignee=me|<id>|unassigned&type=bug,...&includeDone=1
//     -> { issues: [issueOut + canEdit], sprints: [...], truncated, from, to }   (at most 92 days, 1000 issues)
//
// Calendar subscription (.ics): a secret URL /feeds/calendar/<token>.ics, stored in the feeds table with kind 'ics'
// (same token handling as the Google Sheets feeds: only the SHA-256 is stored, runs as its owner with the owner's
// current permissions, admin setting sheetFeeds turns all feeds off, revoke with DELETE /api/feeds/:id).
import { body, fail, str, isoDate } from '../lib/http.js';
import { uuid, now, randomToken, sha256 } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { getSettings } from '../lib/settings.js';
import { addDays, daysBetween } from '../lib/time.js';
import { visibleProjectsSql, permissions, issueRights } from '../lib/access.js';
import { ISSUE_SELECT, issueOut, TYPES } from '../lib/issues/model.js';
import { issueFilter } from '../lib/issues/search.js';
import { publicOrigin } from '../lib/http.js';
import { placeholders, chunks } from '../db/sql.js';

export const CALENDAR_MAX_DAYS = 92;
export const CALENDAR_MAX_ISSUES = 1000;
const MAX_FEEDS = 25; // per person, together with the Sheets feeds

/** Calendar query keys a subscription may keep. */
function cleanCalendarQuery(q) {
  const out = {};
  if (!q || typeof q !== 'object' || Array.isArray(q)) return out;
  for (const k of ['project', 'assignee', 'type']) {
    if (q[k] === undefined || q[k] === null || q[k] === '') continue;
    const v = String(q[k]).trim();
    if (v.length > 200) fail(400, `${k} is too long`);
    if (v) out[k] = v;
  }
  if (out.type && out.type.split(',').some((t) => !TYPES.includes(t.trim()))) fail(400, `Type must be one of: ${TYPES.join(', ')}`);
  if (q.includeDone === '1' || q.includeDone === true) out.includeDone = '1';
  return out;
}

/** Issues whose start to due span (or due date alone) touches [from, to], as the user sees them. */
export async function calendarIssues(db, user, q, { from, to, max = CALENDAR_MAX_ISSUES }) {
  const f = issueFilter(user, { project: q.project, assignee: q.assignee, type: q.type });
  let where = `${f.where} AND (i.due_date IS NOT NULL OR i.start_date IS NOT NULL)
    AND COALESCE(i.start_date, i.due_date) <= ? AND COALESCE(i.due_date, i.start_date) >= ?`;
  if (q.includeDone !== '1') where += ` AND s.category <> 'done'`;
  const rows = await db.all(`${ISSUE_SELECT} WHERE ${where} ORDER BY COALESCE(i.due_date, i.start_date), p.key, i.number LIMIT ?`, [
    ...f.params,
    to,
    from,
    max + 1,
  ]);
  const truncated = rows.length > max;
  return { rows: rows.slice(0, max), truncated };
}

/** canEdit per issue (the drag to another day): one query for the projects and the caller's roles. */
async function withEditRights(db, user, rows) {
  const ids = [...new Set(rows.map((r) => r.project_id))];
  const perms = new Map();
  for (const part of chunks(ids)) {
    const projects = await db.all(
      `SELECT p.*, m.role AS my_role FROM projects p LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = ? WHERE p.id IN (${placeholders(part.length)})`,
      [user.id, ...part],
    );
    for (const p of projects) perms.set(p.id, permissions(user, p, p.my_role));
  }
  return rows.map((r) => {
    const access = perms.get(r.project_id);
    return { ...issueOut(r), canEdit: Boolean(access && issueRights(access, user, r).canEdit) };
  });
}

async function calendarSprints(db, user, q, from, to) {
  const v = visibleProjectsSql(user);
  const keys = String(q.project || '')
    .split(',')
    .map((k) => k.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 50);
  const rows = await db.all(
    `SELECT sp.id, sp.name, sp.state, sp.start_date, sp.end_date, sp.goal, p.key AS project_key FROM sprints sp JOIN projects p ON p.id = sp.project_id
      WHERE ${v.sql} AND p.archived = 0 AND sp.start_date IS NOT NULL AND sp.start_date <= ? AND COALESCE(sp.end_date, sp.start_date) >= ?
      ${keys.length ? `AND p.key IN (${placeholders(keys.length)})` : ''}
      ORDER BY sp.start_date LIMIT 200`,
    [...v.params, to, from, ...keys],
  );
  return rows.map((s) => ({
    id: s.id,
    name: s.name,
    state: s.state,
    startDate: s.start_date,
    endDate: s.end_date || s.start_date,
    goal: s.goal,
    projectKey: s.project_key,
  }));
}

// ---- .ics ----
const icsText = (s) =>
  String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
function fold(line) {
  const out = [];
  let rest = line;
  while (rest.length > 74) {
    out.push(rest.slice(0, 74));
    rest = ` ${rest.slice(74)}`;
  }
  out.push(rest);
  return out.join('\r\n');
}
const icsDate = (d) => d.replace(/-/g, '');

export function buildIcs(issues, { origin, name }) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Opentrack//Opentrack//EN',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${icsText(name)}`,
  ];
  for (const i of issues) {
    const start = i.startDate || i.dueDate;
    const end = i.dueDate || i.startDate;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${i.id}@opentrack`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(start)}`,
      `DTEND;VALUE=DATE:${icsDate(addDays(end, 1))}`,
      `SUMMARY:${icsText(`${i.key} ${i.title}`)}`,
      `DESCRIPTION:${icsText(`${i.status.name}${i.assignee ? `, assigned to ${i.assignee.name}` : ''}. ${origin}/browse/${i.key}`)}`,
      `URL:${origin}/browse/${i.key}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

export function registerCalendar(app) {
  app.get('/api/calendar', async (c) => {
    const q = c.req.query();
    const from = isoDate(q.from, 'from');
    const to = isoDate(q.to, 'to');
    if (!from || !to) fail(400, 'from and to are required (YYYY-MM-DD)');
    if (to < from) fail(400, 'to must be on or after from');
    if (daysBetween(from, to) > CALENDAR_MAX_DAYS) fail(400, `At most ${CALENDAR_MAX_DAYS} days at a time`);
    const query = cleanCalendarQuery(q);
    const db = c.env.db;
    const user = c.get('user');
    const [{ rows, truncated }, sprints] = await Promise.all([
      calendarIssues(db, user, query, { from, to }),
      calendarSprints(db, user, query, from, to),
    ]);
    return c.json({ from, to, issues: await withEditRights(db, user, rows), sprints, truncated, max: CALENDAR_MAX_ISSUES });
  });

  // Calendar subscriptions (kind 'ics' in the feeds table)
  app.get('/api/calendar/feeds', async (c) => {
    const rows = await c.env.db.all(
      `SELECT id, name, query, prefix, created_at, last_used_at FROM feeds WHERE owner_id = ? AND kind = 'ics' AND revoked_at IS NULL ORDER BY created_at DESC`,
      [c.get('user').id],
    );
    const settings = await getSettings(c.env.db);
    return c.json({
      enabled: settings.sheetFeeds,
      feeds: rows.map((f) => ({
        id: f.id,
        name: f.name,
        query: JSON.parse(f.query || '{}'),
        prefix: f.prefix,
        createdAt: f.created_at,
        lastUsedAt: f.last_used_at,
      })),
    });
  });

  app.post('/api/calendar/feeds', async (c) => {
    const db = c.env.db;
    const user = c.get('user');
    if (c.get('authVia') === 'token') fail(403, 'Calendar subscriptions can only be created in the web app');
    if (!(await getSettings(db)).sheetFeeds) fail(403, 'Feeds are turned off by an admin');
    const b = await body(c);
    const name = str(b.name, { max: 100, name: 'Name' }) || 'Opentrack calendar';
    const query = cleanCalendarQuery(b.query);
    const count = await db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM feeds WHERE owner_id = ? AND revoked_at IS NULL', [user.id]);
    if (count.n >= MAX_FEEDS) fail(400, `You can have at most ${MAX_FEEDS} feeds. Revoke one first.`);
    const token = randomToken(32);
    const id = uuid();
    await db.batch([
      {
        sql: `INSERT INTO feeds (id, owner_id, name, query, columns, token_hash, prefix, created_at, kind) VALUES (?, ?, ?, ?, '[]', ?, ?, ?, 'ics')`,
        params: [id, user.id, name, JSON.stringify(query), await sha256(token), token.slice(0, 6), now()],
      },
      audit(user.id, 'feed.created', 'feed', id, { name, query, kind: 'ics' }),
    ]);
    const url = `${publicOrigin(c)}/feeds/calendar/${token}.ics`;
    return c.json({ feed: { id, name, query, prefix: token.slice(0, 6) }, url }, 201);
  });

  // Public: the .ics itself. No cookie; the token in the URL is the only key. Issues from 60 days ago to a year ahead.
  app.get('/feeds/calendar/:file', async (c) => {
    const notFound = () => c.text('Feed not found', 404, { 'cache-control': 'no-store' });
    const m = /^([A-Za-z0-9_-]{20,100})\.ics$/.exec(c.req.param('file') || '');
    if (!m) return notFound();
    const db = c.env.db;
    if (!(await getSettings(db)).sheetFeeds) return notFound();
    const feed = await db.get(
      `SELECT f.*, u.id AS uid, u.email, u.name AS owner_name, u.role, u.status
         FROM feeds f JOIN users u ON u.id = f.owner_id WHERE f.token_hash = ? AND f.revoked_at IS NULL AND f.kind = 'ics'`,
      [await sha256(m[1])],
    );
    if (!feed || feed.status !== 'active') return notFound();
    const owner = { id: feed.uid, email: feed.email, name: feed.owner_name, role: feed.role, status: feed.status };
    let query = {};
    try {
      query = cleanCalendarQuery(JSON.parse(feed.query || '{}'));
    } catch {
      /* bad stored query: no filters */
    }
    const today = new Date().toISOString().slice(0, 10);
    const { rows } = await calendarIssues(db, owner, query, { from: addDays(today, -60), to: addDays(today, 365) });
    if (!feed.last_used_at || feed.last_used_at < new Date(Date.now() - 300e3).toISOString()) {
      await db.run('UPDATE feeds SET last_used_at = ? WHERE id = ?', [now(), feed.id]);
    }
    return c.body(
      buildIcs(
        rows.map((r) => issueOut(r)),
        { origin: publicOrigin(c), name: feed.name },
      ),
      200,
      {
        'content-type': 'text/calendar; charset=utf-8',
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex',
      },
    );
  });
}
