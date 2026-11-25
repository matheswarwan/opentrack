import { fail, isoDate } from '../lib/http.js';
import { visibleProjectsSql } from '../lib/access.js';
import { weekOut, WEEK_SELECT } from '../lib/timeTracking.js';
import { DAY, addDays, mondayOf, today } from '../lib/time.js';

/**
 * Hours logged per person, issue and day. Everyone sees their own; admins can see anyone's
 * and the whole team. Only work on projects the viewer can see is included.
 */
export function registerTimesheet(app) {
  app.get('/api/timesheet', async (c) => {
    const db = c.env.db;
    const me = c.get('user');
    const from = isoDate(c.req.query('from'), 'From') || addDays(await today(c), -6);
    const to = isoDate(c.req.query('to'), 'To') || addDays(from, 6);
    if (to < from) fail(400, 'To must be on or after From');
    if ((Date.parse(to) - Date.parse(from)) / DAY > 92) fail(400, 'At most 93 days at a time');
    const who = c.req.query('user') || 'me';
    const team = who === 'team';
    if ((team || (who !== 'me' && who !== me.id)) && me.role !== 'admin') fail(403, "Only admins can see other people's time");
    const userId = who === 'me' ? me.id : who;
    const v = visibleProjectsSql(me);
    const rows = await db.all(
      `SELECT w.id, w.hours, w.note, w.work_date, w.user_id, w.billable, u.name AS user_name, u.avatar_color,
              i.key, i.title, i.type, p.key AS project_key, p.name AS project_name
         FROM worklogs w JOIN issues i ON i.id = w.issue_id JOIN projects p ON p.id = i.project_id
         LEFT JOIN users u ON u.id = w.user_id
        WHERE i.deleted_at IS NULL AND ${v.sql} AND w.work_date >= ? AND w.work_date <= ? ${team ? '' : 'AND w.user_id = ?'}
        ORDER BY w.work_date, i.key`,
      [...v.params, from, to, ...(team ? [] : [userId])],
    );
    // One person's Monday to Sunday week: whether it was submitted for approval (server/routes/timeTracking.js)
    const oneWeek = !team && from === mondayOf(from) && to === addDays(from, 6);
    const sub = oneWeek ? await db.get(`${WEEK_SELECT} WHERE tw.user_id = ? AND tw.week_start = ?`, [userId, from]) : null;
    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
    const sum = (list) => Math.round(list.reduce((s, r) => s + Number(r.hours), 0) * 100) / 100;
    const group = (keyFn) => {
      const m = new Map();
      for (const r of rows) {
        const k = keyFn(r);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(r);
      }
      return m;
    };
    const byIssue = [...group((r) => r.key).entries()].map(([key, list]) => ({
      key,
      title: list[0].title,
      type: list[0].type,
      projectKey: list[0].project_key,
      projectName: list[0].project_name,
      perDay: Object.fromEntries(days.map((d) => [d, sum(list.filter((r) => r.work_date === d))])),
      total: sum(list),
    }));
    const byUser = [...group((r) => r.user_id || 'former').entries()].map(([id, list]) => ({
      id,
      name: list[0].user_name || 'Former user',
      avatarColor: list[0].avatar_color,
      perDay: Object.fromEntries(days.map((d) => [d, sum(list.filter((r) => r.work_date === d))])),
      total: sum(list),
    }));
    const byProject = [...group((r) => r.project_key).entries()].map(([key, list]) => ({
      key,
      name: list[0].project_name,
      total: sum(list),
    }));
    const nonBillable = sum(rows.filter((r) => !Number(r.billable)));
    return c.json({
      from,
      to,
      days,
      user: team ? 'team' : userId,
      total: sum(rows),
      submission: sub ? weekOut(sub) : null,
      canSubmit: oneWeek && userId === me.id && me.role !== 'guest',
      nonBillable,
      perDay: Object.fromEntries(days.map((d) => [d, sum(rows.filter((r) => r.work_date === d))])),
      byIssue,
      byUser,
      byProject,
      entries: rows.map((r) => ({
        id: r.id,
        hours: Number(r.hours),
        note: r.note,
        billable: Boolean(Number(r.billable)),
        date: r.work_date,
        key: r.key,
        title: r.title,
        projectKey: r.project_key,
        user: { id: r.user_id, name: r.user_name },
      })),
    });
  });
}
