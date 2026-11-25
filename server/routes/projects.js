import { body, fail, str, oneOf, num, isoDate } from '../lib/http.js';
import { uuid, now } from '../lib/crypto.js';
import { historyStmt, changeSource } from '../lib/history.js';
import { STATUS_CATEGORIES } from '../lib/issues/model.js';
import { requireWriter, requireNotGuest } from '../lib/session.js';
import { audit } from '../lib/audit.js';
import { getSettings } from '../lib/settings.js';
import { projectAccess, visibleProjectsSql, permissions, projectPerms, PROJECT_PERMS, MEMBER_ROLES, GUEST_LEVELS } from '../lib/access.js';
import { slackNotify } from '../lib/slack.js';
import { webhookNotify } from '../lib/webhooks.js';
import { avatarUrl } from '../lib/avatars.js';
import { listFields } from '../lib/customFields.js';
import { projectReleaseLists } from '../lib/releases.js';
import { parseWorkflow, workflowSummary, readWorkflow, withoutStatus, REQUIRABLE } from '../lib/workflow.js';
import { planTemplate } from '../lib/projectTemplates.js';
import { templateForUse } from './projectTemplates.js';
import { clock, localParts, workspaceTz, addDays, today } from '../lib/time.js';
import { placeholders } from '../db/sql.js';

const DEFAULT_STATUSES = [
  ['To Do', 'todo'],
  ['In Progress', 'in_progress'],
  ['In Review', 'in_progress'],
  ['Done', 'done'],
];

function projectOut(p, perms) {
  return {
    id: p.id,
    key: p.key,
    name: p.name,
    description: p.description,
    visibility: p.visibility,
    leadId: p.lead_id,
    leadName: p.lead_name,
    archived: Boolean(p.archived),
    createdAt: p.created_at,
    openIssues: p.open_issues ?? undefined,
    permissions: projectPerms(p), // who may delete, manage sprints, create, comment
    ...(perms
      ? {
          canEdit: perms.canEdit,
          canAdmin: perms.canAdmin,
          myRole: perms.memberRole,
          canCreate: perms.canCreate,
          canComment: perms.canComment,
          canSprints: perms.canSprints,
          canWatch: perms.canWatch,
          canEditOwn: perms.canEditOwn,
          guest: perms.guest,
        }
      : {}),
  };
}

const sprintOut = (s) => ({
  id: s.id,
  name: s.name,
  goal: s.goal,
  state: s.state,
  startDate: s.start_date,
  endDate: s.end_date,
  completedAt: s.completed_at,
  createdAt: s.created_at,
});

const statusOut = (s) => ({ id: s.id, name: s.name, category: s.category, position: s.position, wipLimit: s.wip_limit });

export async function projectDetail(db, project) {
  const [statuses, members, sprints] = await Promise.all([
    db.all('SELECT * FROM statuses WHERE project_id = ? ORDER BY position', [project.id]),
    db.all(
      `SELECT m.user_id, m.role, u.name, u.email, u.avatar_color, u.avatar_version, u.status, u.role AS user_role FROM project_members m
         JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY LOWER(u.name)`,
      [project.id],
    ),
    db.all(`SELECT * FROM sprints WHERE project_id = ? AND state <> 'closed' ORDER BY created_at`, [project.id]),
  ]);
  return {
    statuses: statuses.map(statusOut),
    members: members.map((m) => ({
      userId: m.user_id,
      role: m.role,
      name: m.name,
      email: m.email,
      avatarColor: m.avatar_color,
      avatarUrl: avatarUrl(m.user_id, m.avatar_version),
      status: m.status,
      guest: m.user_role === 'guest',
    })),
    sprints: sprints.map(sprintOut),
  };
}

export function registerProjects(app) {
  app.get('/api/projects', async (c) => {
    const user = c.get('user');
    const v = visibleProjectsSql(user);
    const archived = c.req.query('archived') === '1';
    const rows = await c.env.db.all(
      `SELECT p.*, l.name AS lead_name, mm.role AS my_role,
              (SELECT CAST(COUNT(*) AS INTEGER) FROM issues i JOIN statuses s ON s.id = i.status_id
                WHERE i.project_id = p.id AND i.deleted_at IS NULL AND s.category <> 'done') AS open_issues
         FROM projects p LEFT JOIN users l ON l.id = p.lead_id
         LEFT JOIN project_members mm ON mm.project_id = p.id AND mm.user_id = ?
        WHERE ${v.sql} AND p.archived = ? ORDER BY p.name`,
      [user.id, ...v.params, archived ? 1 : 0],
    );
    return c.json({ projects: rows.map((p) => projectOut(p, permissions(user, p, p.my_role))) });
  });

  app.post('/api/projects', async (c) => {
    requireWriter(c);
    requireNotGuest(c, 'create projects');
    const db = c.env.db;
    const user = c.get('user');
    const settings = await getSettings(db);
    if (settings.projectCreation === 'admins' && user.role !== 'admin') fail(403, 'Only admins can create projects');
    if (Array.isArray(user.projectScope)) fail(403, 'This API token is limited to some projects, so it cannot create projects');
    const b = await body(c);
    const key = str(b.key, { required: true, max: 10, name: 'Key' }).toUpperCase();
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(key)) fail(400, 'Key must be 2 to 10 letters or digits and start with a letter');
    const name = str(b.name, { required: true, max: 100, name: 'Name' });
    const description = str(b.description, { max: 5000, name: 'Description' }) || null;
    const visibility = oneOf(b.visibility || 'open', ['open', 'private'], 'Visibility');
    const leadId = b.leadId || user.id;
    if (!(await db.get(`SELECT id FROM users WHERE id = ? AND status <> 'deactivated'`, [leadId]))) fail(400, 'Lead not found');
    const taken = await db.get('SELECT id, deleted_at FROM projects WHERE key = ?', [key]);
    if (taken)
      fail(
        409,
        taken.deleted_at
          ? `Key ${key} belongs to a deleted project in the Trash. Restore it, or delete it forever first.`
          : `Key ${key} is already used`,
      );
    const id = uuid();
    const t = now();
    // Optional project template (server/lib/projectTemplates.js): statuses, workflow, fields, components, issue
    // templates, recurring rules, permissions, starter issues with dates counted from startDate, a first sprint.
    let plan = null;
    let tpl = null;
    if (b.templateId && b.templateId !== 'blank') {
      tpl = await templateForUse(db, user, b.templateId);
      const startDate = isoDate(b.startDate, 'Start date') || localParts(clock(c.env), workspaceTz(settings)).date;
      plan = planTemplate(tpl.body, { projectId: id, projectKey: key, creatorId: user.id, leadId, startDate, t });
    }
    const extra = plan ? plan.project : {};
    const cols = [
      'id',
      'key',
      'name',
      'description',
      'lead_id',
      'visibility',
      'created_by',
      'created_at',
      'updated_at',
      ...Object.keys(extra),
    ];
    const statuses = plan
      ? plan.statuses
      : DEFAULT_STATUSES.map(([n, cat], i) => ({ id: uuid(), name: n, category: cat, position: i, wipLimit: null }));
    const stmts = [
      {
        sql: `INSERT INTO projects (${cols.join(', ')}) VALUES (${placeholders(cols.length)})`,
        params: [id, key, name, description, leadId, visibility, user.id, t, t, ...Object.values(extra)],
      },
      ...statuses.map((s) => ({
        sql: 'INSERT INTO statuses (id, project_id, name, category, position, wip_limit) VALUES (?, ?, ?, ?, ?, ?)',
        params: [s.id, id, s.name, s.category, s.position, s.wipLimit ?? null],
      })),
      { sql: `INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'admin', ?)`, params: [id, user.id, t] },
      audit(user.id, 'project.created', 'project', id, { key, name, ...(tpl ? { template: tpl.name } : {}) }),
    ];
    if (leadId !== user.id) {
      stmts.push({
        sql: `INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'admin', ?)`,
        params: [id, leadId, t],
      });
    }
    if (plan) stmts.push(...plan.stmts);
    await db.batch(stmts);
    const a = await projectAccess(c, id);
    return c.json(
      {
        project: { ...projectOut(a.project, a), ...(await projectDetail(db, a.project)) },
        ...(tpl ? { template: { id: tpl.id, name: tpl.name, summary: plan.summary } } : {}),
      },
      201,
    );
  });

  app.get('/api/projects/:key', async (c) => {
    const a = await projectAccess(c, c.req.param('key'));
    const lead = a.project.lead_id ? await c.env.db.get('SELECT name FROM users WHERE id = ?', [a.project.lead_id]) : null;
    return c.json({
      project: {
        ...projectOut({ ...a.project, lead_name: lead?.name }, a),
        ...(await projectDetail(c.env.db, a.project)),
        fields: await listFields(c.env.db, a.project.id),
        ...(await projectReleaseLists(c.env.db, a.project.id)),
        workflow: workflowSummary(a.project.workflow),
      },
    }); // components, releases: for pickers; workflow: allowed moves and required values
  });

  app.patch('/api/projects/:key', async (c) => {
    const a = await projectAccess(c, c.req.param('key'), 'admin');
    const b = await body(c);
    const db = c.env.db;
    const fields = {
      name: str(b.name, { max: 100, name: 'Name' }),
      description: str(b.description, { max: 5000, name: 'Description' }),
      visibility: oneOf(b.visibility, ['open', 'private'], 'Visibility'),
      lead_id: b.leadId,
      archived: b.archived === undefined ? undefined : b.archived ? 1 : 0,
    };
    // permissions: { delete: 'reporter'|'admins', sprints: 'members'|'admins', create: 'members'|'admins', comment: 'all'|'members' }
    if (b.permissions !== undefined) {
      if (!b.permissions || typeof b.permissions !== 'object' || Array.isArray(b.permissions)) fail(400, 'permissions must be an object');
      for (const [k, v] of Object.entries(b.permissions)) {
        const d = PROJECT_PERMS[k];
        if (!d) fail(400, `Unknown permission: ${k}`);
        fields[d.col] = oneOf(v, d.values, `Permission ${k}`);
      }
    }
    if (fields.name === '') fail(400, 'Name is required');
    if (fields.lead_id && !(await db.get(`SELECT id FROM users WHERE id = ? AND status <> 'deactivated'`, [fields.lead_id])))
      fail(400, 'Lead not found');
    const sets = [];
    const params = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      params.push(v);
    }
    if (sets.length) {
      await db.batch([
        { sql: `UPDATE projects SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, params: [...params, now(), a.project.id] },
        audit(c.get('user').id, 'project.updated', 'project', a.project.id, b),
      ]);
    }
    const fresh = await projectAccess(c, a.project.id);
    return c.json({ project: { ...projectOut(fresh.project, fresh), ...(await projectDetail(db, fresh.project)) } });
  });

  // ---- members ----
  app.put('/api/projects/:key/members/:userId', async (c) => {
    const a = await projectAccess(c, c.req.param('key'), 'admin');
    const b = await body(c);
    const userId = c.req.param('userId');
    const db = c.env.db;
    const target = await db.get(`SELECT id, role FROM users WHERE id = ? AND status <> 'deactivated'`, [userId]);
    if (!target) fail(404, 'User not found');
    // Guests get one of the guest levels (default read only); everyone else a normal role.
    const role =
      target.role === 'guest'
        ? oneOf(b.role || 'guest-view', GUEST_LEVELS, 'Role for a guest')
        : oneOf(b.role || 'member', MEMBER_ROLES, 'Role');
    await db.batch([
      { sql: 'DELETE FROM project_members WHERE project_id = ? AND user_id = ?', params: [a.project.id, userId] },
      {
        sql: 'INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, ?, ?)',
        params: [a.project.id, userId, role, now()],
      },
    ]);
    return c.json(await projectDetail(db, a.project));
  });

  app.delete('/api/projects/:key/members/:userId', async (c) => {
    const a = await projectAccess(c, c.req.param('key'), 'admin');
    await c.env.db.run('DELETE FROM project_members WHERE project_id = ? AND user_id = ?', [a.project.id, c.req.param('userId')]);
    return c.json(await projectDetail(c.env.db, a.project));
  });

  // ---- statuses (workflow columns) ----
  app.post('/api/projects/:key/statuses', async (c) => {
    const a = await projectAccess(c, c.req.param('key'), 'admin');
    const b = await body(c);
    const name = str(b.name, { required: true, max: 40, name: 'Name' });
    const category = oneOf(b.category || 'in_progress', STATUS_CATEGORIES, 'Category');
    const db = c.env.db;
    const max = await db.get('SELECT MAX(position) AS m FROM statuses WHERE project_id = ?', [a.project.id]);
    await db.run('INSERT INTO statuses (id, project_id, name, category, position, wip_limit) VALUES (?, ?, ?, ?, ?, ?)', [
      uuid(),
      a.project.id,
      name,
      category,
      (max?.m ?? -1) + 1,
      num(b.wipLimit, { name: 'WIP limit', min: 0, max: 999 }) ?? null,
    ]);
    return c.json(await projectDetail(db, a.project), 201);
  });

  app.patch('/api/projects/:key/statuses/:id', async (c) => {
    const a = await projectAccess(c, c.req.param('key'), 'admin');
    const b = await body(c);
    const db = c.env.db;
    const st = await db.get('SELECT * FROM statuses WHERE id = ? AND project_id = ?', [c.req.param('id'), a.project.id]);
    if (!st) fail(404, 'Status not found');
    const name = str(b.name, { max: 40, name: 'Name' });
    if (name === '') fail(400, 'Name is required');
    const category = oneOf(b.category, STATUS_CATEGORIES, 'Category');
    const wip = num(b.wipLimit, { name: 'WIP limit', min: 0, max: 999 });
    await db.run('UPDATE statuses SET name = ?, category = ?, wip_limit = ? WHERE id = ?', [
      name ?? st.name,
      category ?? st.category,
      wip === undefined ? st.wip_limit : wip,
      st.id,
    ]);
    return c.json(await projectDetail(db, a.project));
  });

  app.put('/api/projects/:key/statuses', async (c) => {
    const a = await projectAccess(c, c.req.param('key'), 'admin');
    const b = await body(c);
    const db = c.env.db;
    const ids = (await db.all('SELECT id FROM statuses WHERE project_id = ?', [a.project.id])).map((r) => r.id);
    if (!Array.isArray(b.order) || b.order.length !== ids.length || !b.order.every((id) => ids.includes(id))) {
      fail(400, 'order must list every status of the project once');
    }
    await db.batch(b.order.map((id, i) => ({ sql: 'UPDATE statuses SET position = ? WHERE id = ?', params: [i, id] })));
    return c.json(await projectDetail(db, a.project));
  });

  // Delete a status; its issues move to `moveTo`.
  app.delete('/api/projects/:key/statuses/:id', async (c) => {
    const a = await projectAccess(c, c.req.param('key'), 'admin');
    const db = c.env.db;
    const id = c.req.param('id');
    const all = await db.all('SELECT id, category FROM statuses WHERE project_id = ?', [a.project.id]);
    if (!all.some((s) => s.id === id)) fail(404, 'Status not found');
    if (all.length <= 1) fail(400, 'A project needs at least one status');
    const moveTo = c.req.query('moveTo');
    const target = all.find((s) => s.id === moveTo && s.id !== id);
    const count = await db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM issues WHERE status_id = ?', [id]);
    if (count.n && !target) fail(400, `${count.n} issues use this status; choose a status to move them to`);
    const stmts = [];
    if (count.n) stmts.push({ sql: 'UPDATE issues SET status_id = ?, updated_at = ? WHERE status_id = ?', params: [target.id, now(), id] });
    stmts.push({ sql: 'DELETE FROM statuses WHERE id = ?', params: [id] });
    if (a.project.workflow)
      stmts.push({ sql: 'UPDATE projects SET workflow = ? WHERE id = ?', params: [withoutStatus(a.project.workflow, id), a.project.id] }); // workflow rules forget it
    await db.batch(stmts);
    return c.json(await projectDetail(db, a.project));
  });

  // ---- workflow rules (lib/workflow.js): allowed moves, required values and automations per status ----
  app.get('/api/projects/:key/workflow', async (c) => {
    const a = await projectAccess(c, c.req.param('key'), 'admin');
    return c.json({ workflow: parseWorkflow(a.project.workflow), requirable: REQUIRABLE });
  });

  app.put('/api/projects/:key/workflow', async (c) => {
    const a = await projectAccess(c, c.req.param('key'), 'admin');
    const db = c.env.db;
    const text = await readWorkflow(db, a.project, await body(c));
    await db.batch([
      { sql: 'UPDATE projects SET workflow = ?, updated_at = ? WHERE id = ?', params: [text, now(), a.project.id] },
      audit(c.get('user').id, 'project.workflow_updated', 'project', a.project.id, { rules: text ? JSON.parse(text) : null }),
    ]);
    return c.json({ workflow: parseWorkflow(text), summary: workflowSummary(text) });
  });

  // ---- sprints ----
  app.get('/api/projects/:key/sprints', async (c) => {
    const a = await projectAccess(c, c.req.param('key'));
    const rows = await c.env.db.all('SELECT * FROM sprints WHERE project_id = ? ORDER BY created_at DESC', [a.project.id]);
    return c.json({ sprints: rows.map(sprintOut) });
  });

  app.post('/api/projects/:key/sprints', async (c) => {
    const a = await projectAccess(c, c.req.param('key'), 'sprints');
    const b = await body(c);
    const db = c.env.db;
    const n = await db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM sprints WHERE project_id = ?', [a.project.id]);
    const name = str(b.name, { max: 80, name: 'Name' }) || `${a.project.key} Sprint ${n.n + 1}`;
    const id = uuid();
    await db.run(
      'INSERT INTO sprints (id, project_id, name, goal, state, start_date, end_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        a.project.id,
        name,
        str(b.goal, { max: 1000, name: 'Goal' }) || null,
        'future',
        isoDate(b.startDate, 'Start date') ?? null,
        isoDate(b.endDate, 'End date') ?? null,
        now(),
      ],
    );
    return c.json({ sprint: sprintOut(await db.get('SELECT * FROM sprints WHERE id = ?', [id])) }, 201);
  });

  async function loadSprint(c, need) {
    const db = c.env.db;
    const s = await db.get('SELECT * FROM sprints WHERE id = ?', [c.req.param('id')]);
    if (!s) fail(404, 'Sprint not found');
    const a = await projectAccess(c, s.project_id, need);
    return { s, a, db };
  }

  app.patch('/api/sprints/:id', async (c) => {
    const { s, db } = await loadSprint(c, 'sprints');
    const b = await body(c);
    const name = str(b.name, { max: 80, name: 'Name' });
    if (name === '') fail(400, 'Name is required');
    const goal = str(b.goal, { max: 1000, name: 'Goal' });
    const start = isoDate(b.startDate, 'Start date');
    const end = isoDate(b.endDate, 'End date');
    await db.run('UPDATE sprints SET name = ?, goal = ?, start_date = ?, end_date = ? WHERE id = ?', [
      name ?? s.name,
      goal === undefined ? s.goal : goal,
      start === undefined ? s.start_date : start,
      end === undefined ? s.end_date : end,
      s.id,
    ]);
    return c.json({ sprint: sprintOut(await db.get('SELECT * FROM sprints WHERE id = ?', [s.id])) });
  });

  app.post('/api/sprints/:id/start', async (c) => {
    const { s, db } = await loadSprint(c, 'sprints');
    if (s.state !== 'future') fail(400, 'Only a future sprint can be started');
    const active = await db.get(`SELECT name FROM sprints WHERE project_id = ? AND state = 'active'`, [s.project_id]);
    if (active) fail(409, `${active.name} is still active. Complete it first.`);
    const b = await body(c);
    const day = await today(c);
    const start = isoDate(b.startDate, 'Start date') || s.start_date || day;
    const end = isoDate(b.endDate, 'End date') || s.end_date || addDays(day, 14);
    await db.batch([
      { sql: `UPDATE sprints SET state = 'active', start_date = ?, end_date = ? WHERE id = ?`, params: [start, end, s.id] },
      audit(c.get('user').id, 'sprint.started', 'sprint', s.id, { name: s.name }), // the exact start time, used by reports
    ]);
    slackNotify(c, {
      type: 'sprint_started',
      projectId: s.project_id,
      sprint: { name: s.name, goal: s.goal, startDate: start, endDate: end },
    }); // Slack, in the background
    webhookNotify(c, {
      event: 'sprint.started',
      projectId: s.project_id,
      sprint: { id: s.id, name: s.name, goal: s.goal || null, startDate: start, endDate: end },
    }); // outgoing webhooks
    return c.json({ sprint: sprintOut(await db.get('SELECT * FROM sprints WHERE id = ?', [s.id])) });
  });

  // Complete: unfinished issues go to `moveTo` (a future sprint id) or the backlog.
  app.post('/api/sprints/:id/complete', async (c) => {
    const { s, db } = await loadSprint(c, 'sprints');
    if (s.state !== 'active') fail(400, 'Only the active sprint can be completed');
    const b = await body(c);
    let moveTo = null;
    if (b.moveTo && b.moveTo !== 'backlog') {
      const t = await db.get(`SELECT id FROM sprints WHERE id = ? AND project_id = ? AND state = 'future'`, [b.moveTo, s.project_id]);
      if (!t) fail(400, 'Move to must be a future sprint of this project');
      moveTo = t.id;
    }
    const open = await db.all(
      `SELECT i.id FROM issues i JOIN statuses st ON st.id = i.status_id WHERE i.sprint_id = ? AND i.deleted_at IS NULL AND st.category <> 'done'`,
      [s.id],
    );
    const t = now();
    const toName = moveTo ? (await db.get('SELECT name FROM sprints WHERE id = ?', [moveTo])).name : null;
    await db.batch([
      ...open.map((r) => ({ sql: 'UPDATE issues SET sprint_id = ?, updated_at = ? WHERE id = ?', params: [moveTo, t, r.id] })),
      // sprint history for the moved issues, so reports can rebuild the sprint's scope
      ...open.map((r) => historyStmt(r.id, c.get('user').id, 'sprint', s.name, toName, t, changeSource(c))),
      { sql: `UPDATE sprints SET state = 'closed', completed_at = ? WHERE id = ?`, params: [t, s.id] },
    ]);
    slackNotify(c, {
      type: 'sprint_completed',
      projectId: s.project_id,
      sprint: { name: s.name },
      movedIssues: open.length,
      movedToId: moveTo,
    }); // Slack, in the background
    webhookNotify(c, {
      event: 'sprint.completed',
      projectId: s.project_id,
      sprint: {
        id: s.id,
        name: s.name,
        goal: s.goal || null,
        startDate: s.start_date,
        endDate: s.end_date,
        completedAt: t,
        movedIssues: open.length,
        movedTo: toName || (open.length ? 'backlog' : null),
      },
    }); // outgoing webhooks
    return c.json({ sprint: sprintOut(await db.get('SELECT * FROM sprints WHERE id = ?', [s.id])), movedIssues: open.length });
  });

  app.delete('/api/sprints/:id', async (c) => {
    const { s, db } = await loadSprint(c, 'sprints');
    if (s.state === 'active') fail(400, 'Complete the active sprint instead of deleting it');
    await db.batch([
      { sql: 'UPDATE issues SET sprint_id = NULL WHERE sprint_id = ?', params: [s.id] },
      { sql: 'DELETE FROM sprints WHERE id = ?', params: [s.id] },
    ]);
    return c.json({ ok: true });
  });
}
