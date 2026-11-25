// Capacity planning (server/lib/capacity.js). Guests get 404 everywhere here.
//   GET    /api/capacity?project=KEY&team=KEY&weeks=8      people x weeks: booked / available hours (+ issues per cell)
//   GET    /api/capacity/export.csv?project&team&weeks      the same grid, one row per person and week
//   GET    /api/capacity/people/:id                        weekly hours and time off (the person or an admin; :id may be "me")
//   PUT    /api/capacity/people/:id                        { weeklyHours } (null = workspace default) (the person or an admin)
//   POST   /api/capacity/people/:id/time-off               { startDate, endDate, note } (the person or an admin)
//   DELETE /api/capacity/time-off/:id                      (the person or an admin)
//   GET    /api/projects/:key/capacity                     members with their allocation % and effective share
//   PUT    /api/projects/:key/capacity                     { allocations: [{ userId, pct (0-100, null = not allocated) }] } (project admins)
//   GET    /api/projects/:key/sprint-capacity              team available hours vs estimated remaining per open sprint
//
// Who sees whom: workspace admins see every active person; others see the people who share a project with them
// (and themselves). Time-off notes only reach the person and admins; others see "away".
import { body, fail, num, str, isoDate } from '../lib/http.js';
import { uuid, now } from '../lib/crypto.js';
import { projectAccess, isGuest, visibleProjectsSql } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import { clock, localParts, addDays, workspaceTz } from '../lib/time.js';
import { getSettings } from '../lib/settings.js';
import { avatarUrl } from '../lib/avatars.js';
import { csvCell } from '../lib/csv.js';
import { DEFAULT_WEEKS, MAX_WEEKS, weekList, loadInputs, buildGrid, shares, sprintCapacity } from '../lib/capacity.js';
import { IN_CHUNK, placeholders, chunks, insertRows } from '../db/sql.js';

const MAX_PEOPLE = IN_CHUNK * 4; // 4 queries per 80 people keeps a request under D1's statement limit
const MAX_TIME_OFF_DAYS = 366;
const LEVEL_WORDS = { none: 'No hours', light: 'Light', good: 'Good', over: 'Over', overloaded: 'Overloaded' };

function noGuests(c) {
  if (isGuest(c.get('user'))) fail(404, 'Not found');
}

async function context(c) {
  const settings = await getSettings(c.env.db);
  const today = localParts(clock(c.env), workspaceTz(settings)).date;
  const defaultHours = Number.isFinite(Number(settings.defaultCapacityHours)) ? Number(settings.defaultCapacityHours) : 40;
  return { today, defaultHours };
}

/** The person whose capacity is read or changed: themselves or, for admins, anyone. */
async function personFor(c, id) {
  const me = c.get('user');
  const userId = id === 'me' ? me.id : id;
  if (userId !== me.id && me.role !== 'admin') fail(403, "Only admins can change other people's capacity");
  const u = await c.env.db.get(`SELECT id, name, role FROM users WHERE id = ? AND status <> 'deactivated' AND is_system = 0`, [userId]);
  if (!u || u.role === 'guest') fail(404, 'Person not found');
  return u;
}

async function grid(c) {
  const db = c.env.db;
  const me = c.get('user');
  const { today, defaultHours } = await context(c);
  const count = Math.min(MAX_WEEKS, Math.max(1, Number.parseInt(c.req.query('weeks') || DEFAULT_WEEKS, 10) || DEFAULT_WEEKS));
  const weeks = weekList(today, count);
  const projectKey = c.req.query('project') || '';
  const teamKey = c.req.query('team') || projectKey;
  const project = projectKey ? (await projectAccess(c, projectKey)).project : null;
  const team = teamKey ? (teamKey === projectKey && project ? project : (await projectAccess(c, teamKey)).project) : null;

  const where = [`u.role <> 'guest'`, `u.status <> 'deactivated'`, 'u.is_system = 0'];
  const params = [];
  if (me.role !== 'admin') {
    where.push(`(u.id = ? OR u.id IN (SELECT m.user_id FROM project_members m JOIN projects p ON p.id = m.project_id
                 JOIN project_members mine ON mine.project_id = m.project_id WHERE mine.user_id = ? AND p.archived = 0))`);
    params.push(me.id, me.id);
  }
  if (team) {
    where.push('u.id IN (SELECT user_id FROM project_members WHERE project_id = ?)');
    params.push(team.id);
  }
  const rows = await db.all(
    `SELECT u.id, u.name, u.avatar_color, u.avatar_version FROM users u WHERE ${where.join(' AND ')} ORDER BY LOWER(u.name) LIMIT ?`,
    [...params, MAX_PEOPLE + 1],
  );
  const truncated = rows.length > MAX_PEOPLE;
  const people = rows.slice(0, MAX_PEOPLE).map((u) => ({
    id: u.id,
    name: u.name,
    avatarColor: u.avatar_color,
    avatarUrl: avatarUrl(u.id, u.avatar_version),
    isMe: u.id === me.id,
  }));
  const ids = people.map((p) => p.id);
  const inputs = ids.length
    ? await loadInputs(db, ids, {
        from: weeks[0].start,
        to: addDays(weeks[weeks.length - 1].start, 6),
        projectId: project?.id,
        visible: visibleProjectsSql(me),
      })
    : { caps: [], off: [], members: [], issues: [] };
  const out = buildGrid(people, inputs, {
    weeks,
    today,
    defaultHours,
    projectId: project?.id,
    showNotes: (id) => id === me.id || me.role === 'admin',
  });
  for (const p of out) p.canEdit = p.id === me.id || me.role === 'admin';
  const totals = weeks.map((w, k) => {
    const available = out.reduce((s, p) => s + p.weeks[k].available, 0);
    const booked = out.reduce((s, p) => s + p.weeks[k].booked, 0);
    return { start: w.start, available: Math.round(available * 10) / 10, booked: Math.round(booked * 10) / 10 };
  });
  return {
    today,
    weeks,
    defaultHours,
    project: project ? { key: project.key, name: project.name } : null,
    team: team ? { key: team.key, name: team.name } : null,
    people: out,
    totals,
    unscheduled: Math.round(out.reduce((s, p) => s + p.unscheduled, 0) * 10) / 10,
    truncated,
    isAdmin: me.role === 'admin',
  };
}

function timeOffOut(t) {
  return { id: t.id, startDate: t.start_date, endDate: t.end_date, note: t.note || '' };
}

export function registerCapacity(app) {
  app.get('/api/capacity', async (c) => {
    noGuests(c);
    return c.json(await grid(c));
  });

  app.get('/api/capacity/export.csv', async (c) => {
    noGuests(c);
    const g = await grid(c);
    const head = [
      'Person',
      'Weekly hours',
      ...(g.project ? ['Allocation %'] : []),
      'Week starting',
      'Available hours',
      'Booked hours',
      'Percent booked',
      'Level',
      'Days away',
    ];
    const lines = [head.map(csvCell).join(',')];
    for (const p of g.people) {
      const lead = [p.name, p.weeklyHours, ...(g.project ? [p.share] : [])];
      for (const w of p.weeks)
        lines.push([...lead, w.start, w.available, w.booked, w.pct ?? '', LEVEL_WORDS[w.level], w.awayDays].map(csvCell).join(','));
      lines.push([...lead, 'Unscheduled', '', p.unscheduled, '', '', ''].map(csvCell).join(','));
      if (p.later) lines.push([...lead, 'Later', '', p.later, '', '', ''].map(csvCell).join(','));
    }
    const name = `capacity-${g.project ? `${g.project.key.toLowerCase()}-` : ''}${g.weeks[0].start}.csv`;
    return c.body(lines.join('\n'), 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${name}"`,
    });
  });

  app.get('/api/capacity/people/:id', async (c) => {
    noGuests(c);
    const u = await personFor(c, c.req.param('id'));
    const db = c.env.db;
    const { today, defaultHours } = await context(c);
    const [cap, off] = await Promise.all([
      db.get('SELECT weekly_hours FROM user_capacity WHERE user_id = ?', [u.id]),
      db.all('SELECT * FROM time_off WHERE user_id = ? AND end_date >= ? ORDER BY start_date', [u.id, addDays(today, -30)]),
    ]);
    return c.json({
      user: { id: u.id, name: u.name },
      weeklyHours: cap ? Number(cap.weekly_hours) : defaultHours,
      custom: Boolean(cap),
      defaultHours,
      timeOff: off.map(timeOffOut),
    });
  });

  app.put('/api/capacity/people/:id', async (c) => {
    noGuests(c);
    const u = await personFor(c, c.req.param('id'));
    const b = await body(c);
    const hours = num(b.weeklyHours, { name: 'Weekly hours', min: 0, max: 100 });
    if (hours === undefined) fail(400, 'weeklyHours is required (null for the workspace default)');
    const me = c.get('user');
    const stmts = [{ sql: 'DELETE FROM user_capacity WHERE user_id = ?', params: [u.id] }];
    if (hours !== null)
      stmts.push({
        sql: 'INSERT INTO user_capacity (user_id, weekly_hours, updated_by, updated_at) VALUES (?, ?, ?, ?)',
        params: [u.id, hours, me.id, now()],
      });
    stmts.push(audit(me.id, 'capacity.hours', 'user', u.id, { weeklyHours: hours }));
    await c.env.db.batch(stmts);
    return c.json({ ok: true, weeklyHours: hours });
  });

  app.post('/api/capacity/people/:id/time-off', async (c) => {
    noGuests(c);
    const u = await personFor(c, c.req.param('id'));
    const b = await body(c);
    const startDate = isoDate(b.startDate, 'Start date');
    const endDate = isoDate(b.endDate, 'End date') || startDate;
    if (!startDate) fail(400, 'Start date is required');
    if (endDate < startDate) fail(400, 'End date must be on or after the start date');
    if ((Date.parse(endDate) - Date.parse(startDate)) / 864e5 + 1 > MAX_TIME_OFF_DAYS)
      fail(400, `At most ${MAX_TIME_OFF_DAYS} days in one entry`);
    const note = str(b.note, { max: 200, name: 'Note' }) || null;
    const id = uuid();
    const me = c.get('user');
    await c.env.db.batch([
      {
        sql: 'INSERT INTO time_off (id, user_id, start_date, end_date, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        params: [id, u.id, startDate, endDate, note, me.id, now()],
      },
      audit(me.id, 'capacity.time_off_added', 'user', u.id, { startDate, endDate }),
    ]);
    return c.json({ timeOff: { id, startDate, endDate, note: note || '' } }, 201);
  });

  app.delete('/api/capacity/time-off/:id', async (c) => {
    noGuests(c);
    const db = c.env.db;
    const row = await db.get('SELECT id, user_id FROM time_off WHERE id = ?', [c.req.param('id')]);
    const me = c.get('user');
    if (!row || (row.user_id !== me.id && me.role !== 'admin')) fail(404, 'Time off not found');
    await db.batch([
      { sql: 'DELETE FROM time_off WHERE id = ?', params: [row.id] },
      audit(me.id, 'capacity.time_off_removed', 'user', row.user_id, null),
    ]);
    return c.json({ ok: true });
  });

  app.get('/api/projects/:key/capacity', async (c) => {
    noGuests(c);
    const a = await projectAccess(c, c.req.param('key'));
    const db = c.env.db;
    const members = await db.all(
      `SELECT u.id, u.name FROM project_members m JOIN users u ON u.id = m.user_id
        WHERE m.project_id = ? AND u.role <> 'guest' AND u.status <> 'deactivated' AND u.is_system = 0 ORDER BY LOWER(u.name)`,
      [a.project.id],
    );
    const ids = members.map((m) => m.id);
    const { members: rows } = ids.length
      ? await loadInputs(db, ids, { from: '0000-00-00', to: '0000-00-00', skipIssues: true })
      : { members: [] };
    const byUser = new Map();
    for (const r of rows) (byUser.get(r.user_id) || byUser.set(r.user_id, []).get(r.user_id)).push(r);
    return c.json({
      canAdmin: a.canAdmin,
      members: members.map((m) => {
        const list = byUser.get(m.id) || [];
        const mine = list.find((r) => r.project_id === a.project.id);
        const sh = shares(list).get(a.project.id) || { share: 0, set: false };
        return {
          userId: m.id,
          name: m.name,
          pct: mine && mine.pct !== null ? Number(mine.pct) : null,
          share: sh.share,
          projects: list.length,
          allocatedElsewhere: list.filter((r) => r.project_id !== a.project.id && r.pct !== null).reduce((s, r) => s + Number(r.pct), 0),
        };
      }),
    });
  });

  app.put('/api/projects/:key/capacity', async (c) => {
    noGuests(c);
    const a = await projectAccess(c, c.req.param('key'), 'admin');
    const b = await body(c);
    if (!Array.isArray(b.allocations) || !b.allocations.length) fail(400, 'allocations must be a list');
    if (b.allocations.length > 200) fail(400, 'At most 200 people at a time');
    const db = c.env.db;
    const list = b.allocations.map((x) => ({
      userId: String(x?.userId || ''),
      pct: num(x?.pct, { name: 'Allocation', min: 0, max: 100 }) ?? null,
    }));
    const ids = [...new Set(list.map((x) => x.userId))];
    if (ids.length !== list.length) fail(400, 'Each person can appear only once');
    const members = new Set();
    for (const part of chunks(ids)) {
      const rows = await db.all(
        `SELECT m.user_id FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? AND u.role <> 'guest' AND m.user_id IN (${placeholders(part.length)})`,
        [a.project.id, ...part],
      );
      for (const r of rows) members.add(r.user_id);
    }
    if (members.size !== ids.length) fail(400, 'Everyone in the list must be a member of the project (guests have no allocation)');
    const me = c.get('user');
    const t = now();
    // few statements whatever the team size: one DELETE per 80 people, one multi-row INSERT per 16 (5 values a row)
    const stmts = [];
    for (const part of chunks(ids)) {
      stmts.push({
        sql: `DELETE FROM project_allocations WHERE project_id = ? AND user_id IN (${placeholders(part.length)})`,
        params: [a.project.id, ...part],
      });
    }
    const set = list.filter((x) => x.pct !== null);
    stmts.push(
      ...insertRows(
        'project_allocations',
        ['project_id', 'user_id', 'pct', 'updated_by', 'updated_at'],
        set.map((x) => [a.project.id, x.userId, x.pct, me.id, t]),
      ),
    );
    stmts.push(audit(me.id, 'capacity.allocations', 'project', a.project.id, { allocations: list }));
    await db.batch(stmts);
    return c.json({ ok: true });
  });

  app.get('/api/projects/:key/sprint-capacity', async (c) => {
    noGuests(c);
    const a = await projectAccess(c, c.req.param('key'));
    const ctx = await context(c);
    return c.json(await sprintCapacity(c.env.db, a.project, ctx));
  });
}
