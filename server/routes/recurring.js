// Recurring issues, per project: /api/projects/:key/recurring. Project admins manage every rule; members (who can
// edit issues) create rules and manage their own. Everyone who can see the project can read them.
// The daily `recurring` job creates the issues (server/lib/recurring.js, server/lib/jobs.js).
import { body, fail } from '../lib/http.js';
import { uuid, now } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { projectAccess } from '../lib/access.js';
import { today, addDays } from '../lib/time.js';
import { readRule, readSchedule, nextDates, describeRule, describeSchedule, MAX_RULES } from '../lib/recurring.js';
import { placeholders } from '../db/sql.js';
import { parseList } from '../lib/json.js';

const RULE_SELECT = `SELECT r.*, a.name AS assignee_name, cu.name AS creator_name, t.name AS template_name FROM recurring_rules r
  LEFT JOIN users a ON a.id = r.assignee_id LEFT JOIN users cu ON cu.id = r.created_by LEFT JOIN issue_templates t ON t.id = r.template_id`;

/** First date the preview should show: today, unless today's issue was already made. */
const previewFrom = (r, day) => (r.last_created_on && r.last_created_on >= day ? addDays(r.last_created_on, 1) : day);

function ruleOut(r, access, user, day) {
  const next = nextDates(r, previewFrom(r, day), 1)[0] || null;
  return {
    id: r.id,
    name: r.name,
    title: r.title,
    type: r.type,
    description: r.description || '',
    priority: r.priority,
    assignee: r.assignee_id ? { id: r.assignee_id, name: r.assignee_name } : null,
    labels: parseList(r.labels),
    templateId: r.template_id,
    templateName: r.template_name || null,
    subtasks: parseList(r.subtasks),
    sprint: r.sprint,
    dueDays: r.due_days,
    schedule: JSON.parse(r.schedule),
    startDate: r.start_date,
    endDate: r.end_date,
    maxCount: r.max_count,
    createdCount: Number(r.created_count),
    paused: Boolean(Number(r.paused)),
    lastCreatedOn: r.last_created_on,
    createdBy: r.created_by ? { id: r.created_by, name: r.creator_name } : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    summary: describeRule(r),
    nextOn: next,
    ended: !next,
    canManage: canManage(access, user, r),
  };
}

// Rules create issues, so they follow the project's create permission (guests never: they cannot edit every issue).
const canManage = (access, user, r) => access.canAdmin || (access.canEdit && access.canCreate && r.created_by === user.id);
function checkRuleRights(access, f) {
  if (!access.canCreate) fail(403, 'Only project admins can create issues in this project');
  if (f.sprint === 'active' && !access.canSprints) fail(403, 'Only project admins can manage sprints in this project');
}

export function registerRecurring(app) {
  async function loadRule(c, need = 'view') {
    const access = await projectAccess(c, c.req.param('key'), need === 'manage' ? 'edit' : 'view');
    const r = await c.env.db.get(`${RULE_SELECT} WHERE r.id = ? AND r.project_id = ?`, [c.req.param('id'), access.project.id]);
    if (!r) fail(404, 'Recurring rule not found');
    if (need === 'manage' && !canManage(access, c.get('user'), r))
      fail(403, 'Only the person who made this rule or a project admin can change it');
    return { access, r, db: c.env.db };
  }

  app.get('/api/projects/:key/recurring', async (c) => {
    const access = await projectAccess(c, c.req.param('key'));
    const day = await today(c);
    const rows = await c.env.db.all(`${RULE_SELECT} WHERE r.project_id = ? ORDER BY LOWER(r.name), r.created_at`, [access.project.id]);
    return c.json({
      rules: rows.map((r) => ruleOut(r, access, c.get('user'), day)),
      canCreate: access.canEdit && access.canCreate,
      today: day,
    });
  });

  // Preview of a schedule that is not saved yet (the create and edit form).
  app.post('/api/projects/:key/recurring/preview', async (c) => {
    await projectAccess(c, c.req.param('key'));
    const b = await body(c);
    const day = await today(c);
    const schedule = readSchedule(b.schedule);
    const rule = { schedule, startDate: b.startDate || day, endDate: b.endDate || null, maxCount: b.maxCount || null, createdCount: 0 };
    const dates = nextDates(rule, day, 5);
    return c.json({ summary: describeRule(rule), schedule: describeSchedule(schedule), dates });
  });

  app.post('/api/projects/:key/recurring', async (c) => {
    const access = await projectAccess(c, c.req.param('key'), 'edit');
    const db = c.env.db;
    const user = c.get('user');
    const day = await today(c);
    const f = await readRule(db, await body(c), null, access.project, day);
    checkRuleRights(access, f);
    const n = await db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM recurring_rules WHERE project_id = ?', [access.project.id]);
    if (n.n >= MAX_RULES) fail(400, `A project can have at most ${MAX_RULES} recurring rules`);
    const id = uuid();
    const t = now();
    const cols = { id, project_id: access.project.id, ...f, created_by: user.id, created_at: t, updated_at: t };
    const keys = Object.keys(cols);
    await db.batch([
      { sql: `INSERT INTO recurring_rules (${keys.join(', ')}) VALUES (${placeholders(keys.length)})`, params: keys.map((k) => cols[k]) },
      audit(user.id, 'recurring.created', 'project', access.project.id, { name: f.name }),
    ]);
    const r = await db.get(`${RULE_SELECT} WHERE r.id = ?`, [id]);
    return c.json({ rule: ruleOut(r, access, user, day) }, 201);
  });

  app.get('/api/projects/:key/recurring/:id', async (c) => {
    const { access, r, db } = await loadRule(c);
    const day = await today(c);
    const runs = await db.all(
      `SELECT o.occurs_on, o.issue_key, o.created_at, i.key AS live_key, i.title, i.deleted_at FROM recurring_occurrences o
         LEFT JOIN issues i ON i.id = o.issue_id WHERE o.rule_id = ? ORDER BY o.occurs_on DESC LIMIT 50`,
      [r.id],
    );
    return c.json({
      rule: ruleOut(r, access, c.get('user'), day),
      runs: runs.map((x) => ({
        date: x.occurs_on,
        key: x.issue_key,
        title: x.title || null,
        createdAt: x.created_at,
        gone: !x.live_key || Boolean(x.deleted_at),
      })),
    });
  });

  app.get('/api/projects/:key/recurring/:id/preview', async (c) => {
    const { r } = await loadRule(c);
    const day = await today(c);
    return c.json({
      summary: describeRule(r),
      dates: Number(r.paused) ? [] : nextDates(r, previewFrom(r, day), 5),
      paused: Boolean(Number(r.paused)),
    });
  });

  app.patch('/api/projects/:key/recurring/:id', async (c) => {
    const { access, r, db } = await loadRule(c, 'manage');
    const day = await today(c);
    const f = await readRule(db, await body(c), r, access.project, day);
    if (f.sprint === 'active' && !access.canSprints) fail(403, 'Only project admins can manage sprints in this project');
    const cols = Object.keys(f);
    if (cols.length) {
      await db.batch([
        {
          sql: `UPDATE recurring_rules SET ${[...cols.map((k) => `${k} = ?`), 'updated_at = ?'].join(', ')} WHERE id = ?`,
          params: [...cols.map((k) => f[k]), now(), r.id],
        },
        audit(c.get('user').id, 'recurring.updated', 'project', access.project.id, { name: f.name || r.name, fields: cols }),
      ]);
    }
    const fresh = await db.get(`${RULE_SELECT} WHERE r.id = ?`, [r.id]);
    return c.json({ rule: ruleOut(fresh, access, c.get('user'), day) });
  });

  app.delete('/api/projects/:key/recurring/:id', async (c) => {
    const { access, r, db } = await loadRule(c, 'manage');
    await db.batch([
      { sql: 'DELETE FROM recurring_rules WHERE id = ?', params: [r.id] },
      audit(c.get('user').id, 'recurring.deleted', 'project', access.project.id, { name: r.name }),
    ]);
    return c.json({ ok: true });
  });
}
