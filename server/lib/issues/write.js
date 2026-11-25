// Issue writes: create, update, move to the Trash, and log work. Used by the routes (routes/issues.js, bulk, channel AI,
// Slack commands, time tracking) and the importers.
import { fail, str, oneOf, num, isoDate } from '../http.js';
import { uuid, now } from '../crypto.js';
import { projectAccess } from '../access.js';
import { slackNotify } from '../slack.js';
import { emailNotify } from '../email.js';
import { webhookNotify, changeList } from '../webhooks.js';
import { trashIssue } from '../trash.js';
import { withFields, readFieldValues, fieldValueStmts, fieldChangeSet } from '../customFields.js';
import { withReleases, resolveIds, releaseInsertStmts, defaultAssignee, releaseChangeSet } from '../releases.js';
import { prepareTransition, requiredMissing } from '../workflow.js';
import { checkBudgetAlerts } from '../budgets.js';
import { clock } from '../time.js';
import { historyStmt, changeSource } from '../history.js';
import { assertWeeksOpen } from '../timeTracking.js';
import { TYPES, PRIORITIES, ISSUE_SELECT, withLabels, checkDates, mentionedIds, cleanLabels } from './model.js';
import { withBlocked, unblockNotices } from './links.js';
import { allocate, firstStatus, issueInsertStatements, announceCreated } from './create.js';
import { loadIssue, checkAssignee, reachable, activeUser, checkParent, checkSprint } from './guards.js';
import { notices, noticeStmts, watchStmt, watcherIds } from '../notifications.js';

/**
 * Write a work log for the signed-in person on an issue they may edit (loaded with loadIssue(c, key, 'edit')).
 * Refused when the week of `date` is approved (see server/lib/timeTracking.js). extra: statements for the same batch.
 */
export async function addWorklog(c, { row, db, access }, { hours, note, date, billable = true }, extra = []) {
  const me = c.get('user');
  await assertWeeksOpen(db, me, [{ userId: me.id, date }]);
  const t = now();
  const id = uuid();
  await db.batch([
    {
      sql: 'INSERT INTO worklogs (id, issue_id, user_id, hours, note, work_date, created_at, billable, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      params: [id, row.id, me.id, hours, note || null, date, t, billable ? 1 : 0, changeSource(c)],
    },
    { sql: 'UPDATE issues SET updated_at = ? WHERE id = ?', params: [t, row.id] },
    ...extra,
  ]);
  await checkBudgetAlerts(db, access.project, { nowMs: clock(c.env), actorId: me.id });
  return id;
}

/**
 * Create an issue as c.get('user') from a POST /api/issues body. Also used by the Slack /tracker command and shortcut
 * (routes/slackCommands.js). Returns the created issue (issueOut shape).
 */
export async function createIssue(c, b) {
  const access = await projectAccess(c, b.projectKey || b.projectId || '', 'create');
  const { project } = access;
  const db = c.env.db;
  const user = c.get('user');
  const type = oneOf(b.type || 'task', TYPES, 'Type');
  const title = str(b.title, { required: true, max: 255, name: 'Title' });
  const description = str(b.description, { max: 50000, name: 'Description' }) || null;
  const priority = oneOf(b.priority || 'medium', PRIORITIES, 'Priority');
  let assigneeId = await checkAssignee(db, project, b.assigneeId || null);
  // components and fix versions (ids or names); a component's default assignee takes an unassigned issue
  const components = b.components === undefined ? [] : await resolveIds(db, project.id, 'components', b.components);
  const fixVersions = b.fixVersions === undefined ? [] : await resolveIds(db, project.id, 'fixVersions', b.fixVersions);
  const byComponent = assigneeId ? null : await defaultAssignee(db, components);
  if (byComponent) assigneeId = byComponent.id;
  const parentId = await checkParent(db, type, b.parentKey || b.parentId, project.id, null);
  if (b.sprintId && !access.canSprints)
    fail(403, access.guest ? 'Guests cannot add issues to a sprint' : 'Only project admins can manage sprints in this project');
  const sprintId = await checkSprint(db, b.sprintId, project.id);
  const labels = cleanLabels(b.labels) || [];
  const st = b.statusId
    ? await db.get('SELECT id, category FROM statuses WHERE id = ? AND project_id = ?', [b.statusId, project.id])
    : await firstStatus(db, project.id);
  if (!st) fail(400, 'Status not found');
  const statusId = st.id;
  const fieldValues = await readFieldValues(db, project.id, b.fields, { type, create: true }); // custom fields (required ones checked)
  const slot = await allocate(db, project);
  const id = uuid();
  const { stmts, notices: made } = issueInsertStatements({
    id,
    project,
    number: slot.number(0),
    rank: slot.rank(0),
    actor: user,
    t: now(),
    source: changeSource(c),
    type,
    title,
    description,
    statusId,
    done: st.category === 'done',
    priority,
    assigneeId,
    reporterId: user.id,
    parentId,
    sprintId,
    labels,
    storyPoints: num(b.storyPoints, { name: 'Story points', min: 0, max: 1000 }) ?? null,
    estimateHours: num(b.estimateHours, { name: 'Estimate', min: 0, max: 10000 }) ?? null,
    dueDate: isoDate(b.dueDate, 'Due date') ?? null,
    startDate: checkDates(isoDate(b.startDate, 'Start date') ?? null, isoDate(b.dueDate, 'Due date') ?? null),
  });
  stmts.push(...fieldValueStmts(id, fieldValues));
  stmts.push(
    ...releaseInsertStmts(
      id,
      components.map((x) => x.id),
      fixVersions.map((x) => x.id),
    ),
  );
  if (byComponent) {
    stmts.push(historyStmt(id, user.id, 'assignee', null, byComponent.name, now(), changeSource(c)));
  }
  const mentioned = await reachable(db, project.id, mentionedIds(description));
  const blocked = new Set(mentionedIds(description).filter((m) => !mentioned.includes(m)));
  // no notice to a guest who is not in the project
  const notes = made.filter((n) => !blocked.has(n.userId));
  await db.batch([...stmts, ...noticeStmts(notes)]);
  announceCreated(c, { issueId: id, projectId: project.id, assigneeId, mentioned, notices: notes, description }); // Slack, webhooks and email, in the background
  const row = await db.get(`${ISSUE_SELECT} WHERE i.id = ?`, [id]);
  const [created] = await withBlocked(db, user, await withLabels(db, [row]));
  await withFields(db, [created]);
  await withReleases(db, [created]);
  return created;
}

// opts.quiet (bulk edits of more than 20 issues): skip the Slack and email hooks so one bulk change
// does not send a burst of messages. In-app notifications and history are written as usual.
// opts.loaded: the result of loadIssue(c, key, 'edit', { full: true }) when the caller already has it (bulk, move).
// opts.rank: a new rank (board drag), saved in the same batch as the change, or on its own when nothing else changed.
// It writes no history and does not touch updated_at by itself.
export async function updateIssue(c, key, b, opts = {}) {
  const { row, current, access, rights, db } = opts.loaded || (await loadIssue(c, key, 'edit', { full: true }));
  const user = c.get('user');
  if (access.guest && b.reporterId !== undefined && b.reporterId !== current.reporter_id) fail(403, 'Guests cannot change the reporter');
  // Workflow rules (lib/workflow.js): the transition check, then the new status's automations merged into the body.
  const statusMove = b.statusId !== undefined && b.statusId !== current.status_id;
  const flow = statusMove ? await prepareTransition(db, { project: access.project, access, user, current, b }) : null;
  if (flow) b = flow.body;
  // comment: a resolution comment sent with a status change (the board and status select ask for it when needed)
  const resolution = str(b.comment, { max: 20000, name: 'Comment' }) || null;
  if (resolution && !statusMove) fail(400, 'A comment can only be sent with a status change; add it as a normal comment');
  if (resolution && !rights.canComment) fail(403, 'You cannot comment in this project');
  const changes = {}; // column -> new value
  const history = []; // [field, old, new] (display values)
  // components and fix versions: { components, fixVersions } replace the lists. A newly added component's default
  // assignee takes the issue when it would end up unassigned (history and notification as a normal assignment).
  const rel = await releaseChangeSet(db, current, b);
  if (rel.assignee && !(b.assigneeId === undefined ? current.assignee_id : b.assigneeId)) b = { ...b, assigneeId: rel.assignee.id };

  const title = str(b.title, { max: 255, name: 'Title' });
  if (title === '' || title === null) fail(400, 'Title is required');
  if (title !== undefined && title !== current.title) {
    changes.title = title;
    history.push(['title', current.title, title]);
  }
  if (b.description !== undefined) {
    const d = str(b.description, { max: 50000, name: 'Description' }) || null;
    if (d !== current.description) {
      changes.description = d;
      history.push(['description', null, null]);
    }
  }
  const type = oneOf(b.type, TYPES, 'Type');
  const newType = type ?? current.type;
  if (type && type !== current.type) {
    if (type === 'subtask' || current.type === 'subtask') {
      if (b.parentKey === undefined && b.parentId === undefined) fail(400, 'Changing to or from a sub-task needs a parent change too');
    }
    if (
      current.type === 'epic' &&
      (await db.get('SELECT id FROM issues WHERE parent_id = ? AND deleted_at IS NULL LIMIT 1', [current.id]))
    ) {
      fail(400, "Move this epic's child issues first");
    }
    changes.type = type;
    history.push(['type', current.type, type]);
  }
  if (b.parentKey !== undefined || b.parentId !== undefined) {
    const pid = await checkParent(db, newType, b.parentKey ?? b.parentId, current.project_id, current.id);
    if (pid !== current.parent_id) {
      changes.parent_id = pid;
      const keys = await db.all(`SELECT id, key FROM issues WHERE id IN (?, ?)`, [current.parent_id || '', pid || '']);
      const k = (id) => keys.find((x) => x.id === id)?.key || null;
      history.push(['parent', k(current.parent_id), k(pid)]);
    }
  } else if (type === 'epic' && current.parent_id) {
    changes.parent_id = null;
    history.push(['parent', row.parent_key, null]);
  }
  const priority = oneOf(b.priority, PRIORITIES, 'Priority');
  if (priority && priority !== current.priority) {
    changes.priority = priority;
    history.push(['priority', current.priority, priority]);
  }
  let newStatus = null;
  if (b.statusId !== undefined && b.statusId !== current.status_id) {
    newStatus = await db.get('SELECT id, name, category FROM statuses WHERE id = ? AND project_id = ?', [b.statusId, current.project_id]);
    if (!newStatus) fail(400, 'Status not found');
    changes.status_id = newStatus.id;
    changes.resolved_at = newStatus.category === 'done' ? current.resolved_at || now() : null;
    history.push(['status', row.status_name, newStatus.name]);
  }
  let newAssignee = undefined;
  if (b.assigneeId !== undefined) {
    const aid = await checkAssignee(db, access.project, b.assigneeId || null);
    if (aid !== current.assignee_id) {
      changes.assignee_id = aid;
      newAssignee = aid;
      const names = await db.all('SELECT id, name FROM users WHERE id IN (?, ?)', [current.assignee_id || '', aid || '']);
      const n = (id) => names.find((x) => x.id === id)?.name || null;
      history.push(['assignee', n(current.assignee_id), n(aid)]);
    }
  }
  if (b.reporterId !== undefined) {
    const rid = await activeUser(db, b.reporterId, 'Reporter');
    if (!rid) fail(400, 'Reporter is required');
    if (rid !== current.reporter_id) {
      changes.reporter_id = rid;
      const names = await db.all('SELECT id, name FROM users WHERE id IN (?, ?)', [current.reporter_id || '', rid]);
      history.push(['reporter', names.find((x) => x.id === current.reporter_id)?.name || null, names.find((x) => x.id === rid)?.name]);
    }
  }
  if (b.sprintId !== undefined) {
    const sid = await checkSprint(db, b.sprintId, current.project_id);
    if (sid !== current.sprint_id) {
      if (!access.canSprints && !flow?.autoSprint)
        fail(403, access.guest ? 'Guests cannot move issues between sprints' : 'Only project admins can manage sprints in this project'); // a workflow automation may
      changes.sprint_id = sid;
      const names = await db.all('SELECT id, name FROM sprints WHERE id IN (?, ?)', [current.sprint_id || '', sid || '']);
      history.push(['sprint', names.find((x) => x.id === current.sprint_id)?.name || null, names.find((x) => x.id === sid)?.name || null]);
    }
  }
  for (const [field, col, max] of [
    ['storyPoints', 'story_points', 1000],
    ['estimateHours', 'estimate_hours', 10000],
  ]) {
    const v = num(b[field], { name: field, min: 0, max });
    if (v !== undefined && v !== current[col]) {
      changes[col] = v;
      history.push([col, current[col], v]);
    }
  }
  const due = isoDate(b.dueDate, 'Due date');
  if (due !== undefined && due !== current.due_date) {
    changes.due_date = due;
    history.push(['due_date', current.due_date, due]);
  }
  // Roadmap start date: start <= due when both are set (checked against the new values of both).
  const start = isoDate(b.startDate, 'Start date');
  checkDates(start === undefined ? current.start_date : start, due === undefined ? current.due_date : due);
  if (start !== undefined && start !== current.start_date) {
    changes.start_date = start;
    history.push(['start_date', current.start_date, start]);
  }
  const labels = cleanLabels(b.labels);
  const stmts = [];
  const fieldSet = await fieldChangeSet(db, current, b.fields, newType); // custom fields: { <fieldId or name>: value }
  stmts.push(...fieldSet.stmts);
  history.push(...fieldSet.history);
  stmts.push(...rel.stmts);
  history.push(...rel.history);
  if (labels) {
    const old = (await db.all('SELECT label FROM issue_labels WHERE issue_id = ? ORDER BY label', [current.id])).map((r) => r.label);
    if ([...labels].sort().join(',') !== old.join(',')) {
      stmts.push({ sql: 'DELETE FROM issue_labels WHERE issue_id = ?', params: [current.id] });
      for (const l of labels) stmts.push({ sql: 'INSERT INTO issue_labels (issue_id, label) VALUES (?, ?)', params: [current.id, l] });
      history.push(['labels', old.join(', ') || null, [...labels].sort().join(', ') || null]);
    }
  }
  if (flow?.required.length) {
    const now_ = (col) => (col in changes ? changes[col] : current[col]);
    const after = {
      assignee_id: now_('assignee_id'),
      story_points: now_('story_points'),
      due_date: now_('due_date'),
      estimate_hours: now_('estimate_hours'),
    };
    const missing = await requiredMissing(db, { required: flow.required, current, after, b, fieldValues: fieldSet.values, type: newType });
    if (missing.length) {
      fail(400, `Moving to ${flow.toStatus.name} needs: ${missing.map((m) => m.label).join(', ')}.`, {
        code: 'required',
        missing,
        status: { id: flow.toStatus.id, name: flow.toStatus.name },
      });
    }
  }
  const addedComments = [];
  const notes = []; // in-app notices of this change (also what email follows)
  const rankSet = opts.rank === undefined ? {} : { rank: opts.rank };
  if (!history.length && opts.rank !== undefined) await db.run('UPDATE issues SET rank = ? WHERE id = ?', [opts.rank, current.id]);
  if (history.length) {
    const t = now();
    const set = { ...changes, ...rankSet };
    stmts.unshift({
      sql: `UPDATE issues SET ${[...Object.keys(set).map((k) => `${k} = ?`), 'updated_at = ?'].join(', ')} WHERE id = ?`,
      params: [...Object.values(set), t, current.id],
    });
    for (const [field, o, n] of history) {
      stmts.push(
        historyStmt(
          current.id,
          user.id,
          field,
          o === null || o === undefined ? null : String(o).slice(0, 2000),
          n === null || n === undefined ? null : String(n).slice(0, 2000),
          t,
          changeSource(c),
        ),
      );
    }
    const watchers = await watcherIds(db, current.id);
    const title = changes.title || current.title;
    if (newAssignee) {
      stmts.push(watchStmt(current.id, newAssignee));
      notes.push(
        ...notices([newAssignee], {
          type: 'assigned',
          issueId: current.id,
          actorId: user.id,
          message: `${user.name} assigned ${current.key} to you: ${title}`,
        }),
      );
    }
    if (newStatus) {
      // a workflow automation may replace the usual notice with its own message
      notes.push(
        ...notices(
          (await reachable(db, current.project_id, watchers)).filter((w) => w !== newAssignee),
          {
            type: 'status',
            issueId: current.id,
            actorId: user.id,
            message: flow?.notify || `${user.name} moved ${current.key} to ${newStatus.name}`,
          },
        ),
      );
      for (const text of [resolution, flow?.comment].filter(Boolean)) {
        const cid = uuid();
        addedComments.push(cid);
        stmts.push({
          sql: 'INSERT INTO comments (id, issue_id, author_id, body, internal, parent_id, created_at, updated_at, source) VALUES (?, ?, ?, ?, 0, NULL, ?, ?, ?)',
          params: [cid, current.id, user.id, text, t, t, changeSource(c)],
        });
      }
      if (newStatus.category === 'done' && row.status_category !== 'done') notes.push(...(await unblockNotices(db, current, user)));
    }
    if (changes.description) {
      const before = new Set(mentionedIds(current.description));
      const fresh = await reachable(
        db,
        current.project_id,
        mentionedIds(changes.description).filter((id) => !before.has(id)),
      );
      notes.push(
        ...notices(fresh, {
          type: 'mentioned',
          issueId: current.id,
          actorId: user.id,
          message: `${user.name} mentioned you in ${current.key}`,
          selfMessage: `You mentioned yourself in ${current.key}`,
        }),
      );
    }
    await db.batch([...stmts, ...noticeStmts(notes)]);
    if (!opts.quiet) {
      // Slack, in the background
      slackNotify(c, {
        type: 'issue_updated',
        issueId: current.id,
        status: newStatus ? { from: row.status_name, to: newStatus.name } : null,
        assignee: 'assignee_id' in changes ? { from: current.assignee_id, to: changes.assignee_id } : null,
        assigned: newAssignee ? [newAssignee] : [],
        description: changes.description ? { before: current.description, after: changes.description } : null,
      });
      emailNotify(c, notes, { text: changes.description, status: newStatus ? { from: row.status_name, to: newStatus.name } : null }); // email, in the background
      webhookNotify(c, { event: 'issue.updated', issueId: current.id, projectId: current.project_id, changes: changeList(history) }); // outgoing webhooks
      for (const commentId of addedComments)
        webhookNotify(c, { event: 'comment.created', issueId: current.id, projectId: current.project_id, commentId, internal: false });
    }
  }
  const fresh = await db.get(`${ISSUE_SELECT} WHERE i.id = ?`, [current.id]);
  const out = (await withBlocked(db, user, await withLabels(db, [fresh])))[0];
  await withReleases(db, [out]);
  return { issue: out, changed: history.map((h) => h[0]) };
}

// Deleting moves the issue and its sub-tasks to the Trash (server/lib/trash.js); Delete forever is /api/trash.
// opts.audit = false: the bulk endpoint writes one audit row for the whole call instead.
export async function deleteIssue(c, key, opts = {}) {
  const { row, db } = await loadIssue(c, key, 'delete'); // project admins, or the reporter when the project allows it
  const user = c.get('user');
  const r = await trashIssue(db, { id: row.id, key: row.key, title: row.title }, user.id, now(), opts);
  if (!opts.quiet) webhookNotify(c, { event: 'issue.deleted', issueId: row.id, projectId: row.project_id, subtasks: r.subtasks }); // outgoing webhooks
  return { ok: true, key: row.key, title: row.title, subtasks: r.subtasks, trashed: true };
}
