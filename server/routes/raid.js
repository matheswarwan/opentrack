// RAID log per project (server/lib/raid.js). Guests get 404 on every RAID endpoint.
//   GET    /api/projects/:key/raid            entries with counts per type and the risk heat map
//                                             ?type&status (a status, comma list, or active)&owner (id, me, none)&overdue=1
//                                             &probability&impact (one heat map cell)&q&sort (score, review, updated, created, ref, title)&dir
//   GET    /api/projects/:key/raid.csv        the same filters as CSV
//   POST   /api/projects/:key/raid            create (members who can edit issues)
//   GET    /api/projects/:key/raid/:id        one entry with its history
//   PATCH  /api/projects/:key/raid/:id        edit (members who can edit issues)
//   DELETE /api/projects/:key/raid/:id        delete (project admins)
//   GET    /api/issues/:key/raid              entries linked to an issue
import { body, fail, str, num, isoDate } from '../lib/http.js';
import { uuid, now } from '../lib/crypto.js';
import { noticeStmts } from '../lib/notifications.js';
import { projectAccess, userCanSee } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import { today } from '../lib/time.js';
import { csvCell } from '../lib/csv.js';
import { loadIssue } from '../lib/issues/guards.js';
import {
  RAID_TYPES,
  TYPE_LABELS,
  statusesFor,
  defaultStatus,
  riskScore,
  refOf,
  entryOut,
  isOverdue,
  historyStatements,
  HISTORY_FIELDS,
  MAX_LINKS,
  MAX_ENTRIES,
  CSV_COLUMNS,
} from '../lib/raid.js';
import { placeholders, insertRows } from '../db/sql.js';

const SELECT = `SELECT r.*, u.name AS owner_name, cu.name AS creator_name FROM raid_entries r
  LEFT JOIN users u ON u.id = r.owner_id LEFT JOIN users cu ON cu.id = r.created_by`;
const LINKS_SELECT = `SELECT l.raid_id, i.key, i.title, s.category FROM raid_links l JOIN issues i ON i.id = l.issue_id JOIN statuses s ON s.id = i.status_id`;
// Ascending comparators, and each sort's default direction.
const SORTS = {
  score: [(a, b) => (a.score ?? -1) - (b.score ?? -1), 'desc'],
  review: [(a, b) => (a.reviewDate || '9999').localeCompare(b.reviewDate || '9999'), 'asc'],
  updated: [(a, b) => a.updatedAt.localeCompare(b.updatedAt), 'desc'],
  created: [(a, b) => a.createdAt.localeCompare(b.createdAt), 'desc'],
  ref: [(a, b) => a.number - b.number, 'desc'],
  title: [(a, b) => a.title.localeCompare(b.title), 'asc'],
};

/** Project access for the RAID log: guests 404; need view, edit or admin. */
export async function raidAccess(c, keyOrId, need = 'view') {
  const a = await projectAccess(c, keyOrId);
  if (a.guest) fail(404, 'Not found');
  if (need === 'edit' && !a.canEdit)
    fail(403, a.project.archived ? 'This project is archived' : 'You cannot change the RAID log of this project');
  if (need === 'admin' && !a.canAdmin) fail(403, 'Only project admins can delete RAID entries');
  return a;
}

const linkOut = (l) => ({ key: l.key, title: l.title, done: l.category === 'done' });

async function loadEntries(db, projectId) {
  const [rows, links] = await Promise.all([
    db.all(`${SELECT} WHERE r.project_id = ? ORDER BY r.number DESC LIMIT ?`, [projectId, MAX_ENTRIES]),
    db.all(`${LINKS_SELECT} JOIN raid_entries r ON r.id = l.raid_id WHERE r.project_id = ? AND i.deleted_at IS NULL ORDER BY i.number`, [
      projectId,
    ]),
  ]);
  const byEntry = new Map();
  for (const l of links) {
    if (!byEntry.has(l.raid_id)) byEntry.set(l.raid_id, []);
    byEntry.get(l.raid_id).push(linkOut(l));
  }
  return rows.map((r) => entryOut(r, byEntry.get(r.id) || []));
}

async function loadEntry(db, projectId, id) {
  const row = await db.get(`${SELECT} WHERE r.id = ? AND r.project_id = ?`, [id, projectId]);
  if (!row) fail(404, 'RAID entry not found');
  const links = await db.all(`${LINKS_SELECT} WHERE l.raid_id = ? AND i.deleted_at IS NULL ORDER BY i.number`, [row.id]);
  return { row, links };
}

/** Filter and sort a list as the query asks. */
export function filterEntries(entries, q, { today: day, meId }) {
  let out = entries;
  if (q.type) out = out.filter((e) => e.type === q.type);
  if (q.status) {
    const set = String(q.status).split(',');
    out = out.filter((e) => set.includes(e.status) || (set.includes('active') && e.active));
  }
  if (q.owner) out = out.filter((e) => (q.owner === 'none' ? !e.owner : e.owner?.id === (q.owner === 'me' ? meId : q.owner)));
  if (q.overdue === '1' || q.overdue === 'true') out = out.filter((e) => isOverdue(e, day));
  if (q.probability) out = out.filter((e) => e.probability === Number(q.probability));
  if (q.impact) out = out.filter((e) => e.impact === Number(q.impact));
  if (q.q) {
    const s = String(q.q).toLowerCase();
    out = out.filter((e) => e.title.toLowerCase().includes(s) || e.ref.toLowerCase() === s || e.description.toLowerCase().includes(s));
  }
  const [cmp, def] = SORTS[q.sort] || SORTS.score;
  const sign = (q.dir === 'asc' || q.dir === 'desc' ? q.dir : def) === 'asc' ? 1 : -1;
  return [...out].sort((a, b) => sign * cmp(a, b) || b.number - a.number);
}

/** Counts per type and the heat map (active risks per probability x impact cell). */
export function summarize(entries, day) {
  const counts = Object.fromEntries(RAID_TYPES.map((t) => [t, 0]));
  const heat = Array.from({ length: 5 }, () => Array(5).fill(0)); // heat[probability - 1][impact - 1]
  let overdue = 0;
  for (const e of entries) {
    counts[e.type] = (counts[e.type] || 0) + 1;
    if (isOverdue(e, day)) overdue += 1;
    if (e.type === 'risk' && e.active && e.probability && e.impact) heat[e.probability - 1][e.impact - 1] += 1;
  }
  return { counts, heat, overdue };
}

const LONG = { max: 20000 };
const rating = (v, name) => {
  const n = num(v, { name, min: 1, max: 5 });
  if (n === undefined || n === null) return n;
  if (!Number.isInteger(n)) fail(400, `${name} must be a whole number from 1 to 5`);
  return n;
};

/** The entry after applying the input over `cur` (a raid_entries row or {}), normalized for its type. */
function readEntry(b, cur = {}) {
  const pick = (k, v) => (v === undefined ? (cur[k] ?? null) : v);
  const type =
    b.type === undefined ? cur.type : RAID_TYPES.includes(b.type) ? b.type : fail(400, 'Type must be risk, assumption, issue or decision');
  if (!type) fail(400, 'Type is required');
  const next = {
    type,
    title: pick('title', b.title === undefined ? undefined : str(b.title, { max: 300, required: true, name: 'Title' })),
    description: pick(
      'description',
      b.description === undefined ? undefined : str(b.description, { ...LONG, name: 'Description' }) || null,
    ),
    review_date: pick('review_date', isoDate(b.reviewDate, 'Review date')),
    probability: pick('probability', rating(b.probability, 'Probability')),
    impact: pick('impact', rating(b.impact, 'Impact')),
    mitigation: pick('mitigation', b.mitigation === undefined ? undefined : str(b.mitigation, { ...LONG, name: 'Mitigation' }) || null),
    contingency: pick(
      'contingency',
      b.contingency === undefined ? undefined : str(b.contingency, { ...LONG, name: 'Contingency' }) || null,
    ),
    decided_by: pick('decided_by', b.decidedBy === undefined ? undefined : str(b.decidedBy, { max: 200, name: 'Decided by' }) || null),
    decided_on: pick('decided_on', isoDate(b.decidedOn, 'Decided on')),
    rationale: pick('rationale', b.rationale === undefined ? undefined : str(b.rationale, { ...LONG, name: 'Rationale' }) || null),
  };
  if (!next.title) fail(400, 'Title is required');
  const allowed = statusesFor(type);
  if (b.status !== undefined) {
    if (!allowed.includes(b.status)) fail(400, `Status of a ${type} must be ${allowed.join(', ')}`);
    next.status = b.status;
  } else next.status = allowed.includes(cur.status) ? cur.status : defaultStatus(type);
  if (type === 'risk') {
    next.score = riskScore(next.probability, next.impact);
  } else {
    Object.assign(next, { probability: null, impact: null, score: null, mitigation: null, contingency: null });
  }
  if (type !== 'decision') Object.assign(next, { decided_by: null, decided_on: null, rationale: null });
  return next;
}

/** Owner: an active, non-guest person who can see the project. Returns { id, name } or null. */
async function readOwner(db, project, id) {
  if (id === null || id === '') return null;
  const u = await db.get(`SELECT id, name, role FROM users WHERE id = ? AND status <> 'deactivated' AND is_system = 0`, [String(id)]);
  if (!u) fail(400, 'Owner not found');
  if (u.role === 'guest') fail(400, 'Guests cannot own RAID entries');
  if (!(await userCanSee(db, project, u))) fail(400, `${u.name} cannot see this project`);
  return u;
}

/** Linked issues from issue keys (this project only, not in the Trash). Returns rows { id, key } in key order given. */
async function readLinks(db, projectId, keys) {
  if (!Array.isArray(keys)) fail(400, 'issueKeys must be a list of issue keys');
  const list = [
    ...new Set(
      keys
        .map((k) =>
          String(k || '')
            .trim()
            .toUpperCase(),
        )
        .filter(Boolean),
    ),
  ];
  if (list.length > MAX_LINKS) fail(400, `At most ${MAX_LINKS} linked issues`);
  if (!list.length) return [];
  const rows = await db.all(
    `SELECT id, key FROM issues WHERE project_id = ? AND deleted_at IS NULL AND key IN (${placeholders(list.length)})`,
    [projectId, ...list],
  );
  const found = new Set(rows.map((r) => r.key));
  const missing = list.filter((k) => !found.has(k));
  if (missing.length) fail(400, `Not issues of this project: ${missing.join(', ')}`);
  return list.map((k) => rows.find((r) => r.key === k));
}

const linkRows = (raidId, links, t) =>
  insertRows(
    'raid_links',
    ['raid_id', 'issue_id', 'created_at'],
    links.map((l) => [raidId, l.id, t]),
  );

function ownerNotice(a, entry, owner, actor, t) {
  if (!owner || owner.id === actor.id) return [];
  return noticeStmts([
    {
      userId: owner.id,
      type: 'raid_owner',
      actorId: actor.id,
      at: t,
      projectId: a.project.id,
      link: `/projects/${a.project.key}/raid?entry=${entry.id}`,
      message: `${actor.name} made you the owner of ${a.project.key} ${refOf(entry.number)} (${TYPE_LABELS[entry.type].toLowerCase()}): ${entry.title}`,
    },
  ]);
}

const COLS = [
  'type',
  'title',
  'description',
  'owner_id',
  'status',
  'review_date',
  'probability',
  'impact',
  'score',
  'mitigation',
  'contingency',
  'decided_by',
  'decided_on',
  'rationale',
];
const show = (v) => (v === null || v === undefined || v === '' ? null : String(v));

export function registerRaid(app) {
  app.get('/api/projects/:key/raid', async (c) => {
    const a = await raidAccess(c, c.req.param('key'));
    const day = await today(c);
    const all = await loadEntries(c.env.db, a.project.id);
    const entries = filterEntries(all, c.req.query(), { today: day, meId: c.get('user').id });
    return c.json({ entries, total: all.length, ...summarize(all, day), today: day, canEdit: a.canEdit, canAdmin: a.canAdmin });
  });

  app.get('/api/projects/:key/raid.csv', async (c) => {
    const a = await raidAccess(c, c.req.param('key'));
    const day = await today(c);
    const entries = filterEntries(await loadEntries(c.env.db, a.project.id), c.req.query(), { today: day, meId: c.get('user').id });
    const lines = [CSV_COLUMNS.map(([h]) => csvCell(h)).join(',')];
    for (const e of entries) lines.push(CSV_COLUMNS.map(([, f]) => csvCell(f(e))).join(','));
    return c.body(lines.join('\n'), 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${a.project.key}-raid-${day}.csv"`,
    });
  });

  app.post('/api/projects/:key/raid', async (c) => {
    const a = await raidAccess(c, c.req.param('key'), 'edit');
    const db = c.env.db;
    const user = c.get('user');
    const b = await body(c);
    const next = readEntry(b);
    const owner = b.ownerId === undefined ? null : await readOwner(db, a.project, b.ownerId);
    const links = b.issueKeys === undefined ? [] : await readLinks(db, a.project.id, b.issueKeys);
    const id = uuid();
    const t = now();
    for (let attempt = 0; ; attempt++) {
      const n = Number((await db.get('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM raid_entries WHERE project_id = ?', [a.project.id])).n);
      const row = { ...next, owner_id: owner?.id || null };
      try {
        await db.batch([
          {
            sql: `INSERT INTO raid_entries (id, project_id, number, ${COLS.join(', ')}, created_by, created_at, updated_at) VALUES (?, ?, ?, ${placeholders(COLS.length)}, ?, ?, ?)`,
            params: [id, a.project.id, n, ...COLS.map((k) => row[k] ?? null), user.id, t, t],
          },
          ...linkRows(id, links, t),
          ...historyStatements(id, user.id, [{ field: 'created', from: null, to: `${TYPE_LABELS[next.type]}: ${next.title}` }], t),
          ...ownerNotice(a, { id, number: n, type: next.type, title: next.title }, owner, user, t),
          audit(user.id, 'raid.created', 'project', a.project.id, { id, ref: refOf(n), type: next.type }),
        ]);
        break;
      } catch (e) {
        if (attempt >= 2 || !/unique|duplicate/i.test(String(e?.message))) throw e; // two creates got the same number
      }
    }
    const { row, links: l } = await loadEntry(db, a.project.id, id);
    return c.json({ entry: entryOut(row, l.map(linkOut)) }, 201);
  });

  app.get('/api/projects/:key/raid/:id', async (c) => {
    const a = await raidAccess(c, c.req.param('key'));
    const { row, links } = await loadEntry(c.env.db, a.project.id, c.req.param('id'));
    const history = await c.env.db.all(
      'SELECT h.id, h.field, h.old_value, h.new_value, h.created_at, u.name FROM raid_history h LEFT JOIN users u ON u.id = h.actor_id WHERE h.raid_id = ? ORDER BY h.created_at, h.seq',
      [row.id],
    );
    return c.json({
      entry: entryOut(row, links.map(linkOut)),
      history: history.map((h) => ({
        id: h.id,
        field: h.field,
        label: HISTORY_FIELDS[h.field] || null,
        from: h.old_value,
        to: h.new_value,
        createdAt: h.created_at,
        actor: h.name ? { name: h.name } : null,
      })),
      canEdit: a.canEdit,
      canAdmin: a.canAdmin,
    });
  });

  app.patch('/api/projects/:key/raid/:id', async (c) => {
    const a = await raidAccess(c, c.req.param('key'), 'edit');
    const db = c.env.db;
    const user = c.get('user');
    const { row, links: curLinks } = await loadEntry(c.env.db, a.project.id, c.req.param('id'));
    const b = await body(c);
    const next = readEntry(b, row);
    let owner = row.owner_id ? { id: row.owner_id, name: row.owner_name } : null;
    if (b.ownerId !== undefined && (b.ownerId || null) !== row.owner_id) owner = await readOwner(db, a.project, b.ownerId);
    next.owner_id = owner?.id || null;
    const changes = [];
    for (const k of COLS) {
      if (k === 'score') continue;
      if (show(next[k]) === show(row[k])) continue;
      if (k === 'owner_id') changes.push({ field: k, from: row.owner_name || null, to: owner?.name || null });
      else changes.push({ field: k, from: show(row[k]), to: show(next[k]) });
    }
    const t = now();
    const stmts = [];
    if (b.issueKeys !== undefined) {
      const links = await readLinks(db, a.project.id, b.issueKeys);
      const before = curLinks
        .map((l) => l.key)
        .sort()
        .join(' ');
      const after = links
        .map((l) => l.key)
        .sort()
        .join(' ');
      if (before !== after) {
        changes.push({ field: 'links', from: before || null, to: after || null });
        stmts.push({ sql: 'DELETE FROM raid_links WHERE raid_id = ?', params: [row.id] }, ...linkRows(row.id, links, t));
      }
    }
    if (changes.length) {
      stmts.unshift({
        sql: `UPDATE raid_entries SET ${COLS.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
        params: [...COLS.map((k) => next[k] ?? null), t, row.id],
      });
      stmts.push(...historyStatements(row.id, user.id, changes, t));
      if (next.owner_id && next.owner_id !== row.owner_id)
        stmts.push(...ownerNotice(a, { id: row.id, number: row.number, type: next.type, title: next.title }, owner, user, t));
      stmts.push(
        audit(user.id, 'raid.updated', 'project', a.project.id, {
          id: row.id,
          ref: refOf(row.number),
          fields: changes.map((ch) => ch.field),
        }),
      );
      await db.batch(stmts);
    }
    const fresh = await loadEntry(c.env.db, a.project.id, c.req.param('id'));
    return c.json({ entry: entryOut(fresh.row, fresh.links.map(linkOut)), changed: changes.map((ch) => ch.field) });
  });

  app.delete('/api/projects/:key/raid/:id', async (c) => {
    const a = await raidAccess(c, c.req.param('key'), 'admin');
    const db = c.env.db;
    const row = await db.get('SELECT id, number, type, title FROM raid_entries WHERE id = ? AND project_id = ?', [
      c.req.param('id'),
      a.project.id,
    ]);
    if (!row) fail(404, 'RAID entry not found');
    await db.batch([
      { sql: 'DELETE FROM raid_entries WHERE id = ?', params: [row.id] },
      audit(c.get('user').id, 'raid.deleted', 'project', a.project.id, {
        id: row.id,
        ref: refOf(row.number),
        type: row.type,
        title: row.title,
      }),
    ]);
    return c.json({ ok: true });
  });

  app.get('/api/issues/:key/raid', async (c) => {
    const { row, access, db } = await loadIssue(c, c.req.param('key'));
    if (access.guest) fail(404, 'Not found');
    const rows = await db.all(
      `SELECT r.id, r.number, r.type, r.title, r.status, r.score FROM raid_links l JOIN raid_entries r ON r.id = l.raid_id
        WHERE l.issue_id = ? ORDER BY r.number`,
      [row.id],
    );
    return c.json({
      project: access.project.key,
      entries: rows.map((r) => ({
        id: r.id,
        ref: refOf(r.number),
        type: r.type,
        title: r.title,
        status: r.status,
        score: r.score === null ? null : Number(r.score),
      })),
    });
  });
}
