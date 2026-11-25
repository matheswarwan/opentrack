// Workflow rules per project (projects.workflow, JSON; validated on write by readWorkflow). Project admins edit them
// in Project settings > Workflow (GET/PUT /api/projects/:key/workflow).
//
//   transitions: null (any status to any) or { <fromStatusId>: [<toStatusId>, ...] }. A status that is not a key
//                has no limits on where it can go; a key with [] means its issues cannot leave it.
//   adminBypass: true (default): project admins may move issues anywhere.
//   statuses: { <statusId>: { required: [...], actions: {...} } }
//     required: values an issue must have when it moves into the status: assignee, storyPoints, dueDate, estimate,
//               fixVersion, components, comment (a resolution comment sent with the move) or cf:<fieldId>.
//     actions (automations, run once by updateIssue in the same request; they never change the status, so they
//              cannot trigger other automations):
//       assignee: { to: 'user' | 'reporter' | 'actor' | 'clear', userId }
//       addLabels, removeLabels: lists of labels
//       field: { fieldId, value } (a custom field value, API form)
//       comment: text added as a comment by the person who moved it; {user}, {status}, {key}, {title}
//       sprint: 'active' | 'backlog'
//       notify: a message to the watchers instead of the usual "moved to" notice; same placeholders
//
// Every status change goes through updateIssue (PATCH, board /move, bulk, MCP), which calls prepareTransition and
// requiredMissing below.
import { fail, str } from './http.js';
import { listFields, readFieldValues, issueValues, appliesTo } from './customFields.js';
import { currentIds } from './releases.js';
import { userCanSee } from './access.js';
import { refusalText, transitionAllowed } from '../../shared/workflow.js';

export const REQUIRABLE = {
  assignee: 'Assignee',
  storyPoints: 'Story points',
  dueDate: 'Due date',
  estimate: 'Estimate',
  fixVersion: 'Fix version',
  components: 'Components',
  comment: 'Resolution comment',
};
const ASSIGN_TO = ['user', 'reporter', 'actor', 'clear'];
const MAX_TEXT = 2000;

const parse = (text) => {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
};

/** The stored rules in a safe shape (unknown keys dropped). */
export function parseWorkflow(text) {
  const raw = parse(text) || {};
  const transitions = raw.transitions && typeof raw.transitions === 'object' && !Array.isArray(raw.transitions) ? raw.transitions : null;
  const statuses = raw.statuses && typeof raw.statuses === 'object' && !Array.isArray(raw.statuses) ? raw.statuses : {};
  return { transitions, adminBypass: raw.adminBypass !== false, statuses };
}

/** What every project member gets in the project payload: enough to dim board columns and to know what a move asks. */
export function workflowSummary(text) {
  const wf = parseWorkflow(text);
  const required = {};
  for (const [id, r] of Object.entries(wf.statuses)) if (Array.isArray(r?.required) && r.required.length) required[id] = r.required;
  return { transitions: wf.transitions, adminBypass: wf.adminBypass, required };
}

export const hasRules = (wf) => Boolean(wf.transitions) || Object.keys(wf.statuses).length > 0;

export { transitionAllowed };

function cleanLabelList(v, name) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail(400, `${name} must be a list`);
  const out = [...new Set(v.map((l) => String(l).trim().replace(/\s+/g, '-')).filter(Boolean))];
  if (out.length > 20 || out.some((l) => l.length > 40)) fail(400, `${name}: at most 20 labels of up to 40 characters`);
  return out;
}

/** Validate a PUT /api/projects/:key/workflow body. Returns the JSON text to store (null when there are no rules). */
export async function readWorkflow(db, project, b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) fail(400, 'Workflow must be an object');
  const statuses = await db.all('SELECT id, name FROM statuses WHERE project_id = ?', [project.id]);
  const ids = new Set(statuses.map((s) => s.id));
  const nameOf = (id) => statuses.find((s) => s.id === id)?.name;
  const out = { transitions: null, adminBypass: b.adminBypass !== false, statuses: {} };

  if (b.transitions !== undefined && b.transitions !== null) {
    if (typeof b.transitions !== 'object' || Array.isArray(b.transitions))
      fail(400, 'transitions must be an object of status id: list of status ids');
    out.transitions = {};
    for (const [from, list] of Object.entries(b.transitions)) {
      if (!ids.has(from)) fail(400, 'Unknown status in transitions');
      if (!Array.isArray(list)) fail(400, `Allowed moves from ${nameOf(from)} must be a list`);
      const to = [...new Set(list.map(String))].filter((x) => x !== from);
      if (to.some((x) => !ids.has(x))) fail(400, 'Unknown status in transitions');
      out.transitions[from] = to;
    }
  }

  let fields = null;
  const fieldsOf = async () => (fields ||= await listFields(db, project.id));
  if (b.statuses !== undefined && b.statuses !== null) {
    if (typeof b.statuses !== 'object' || Array.isArray(b.statuses)) fail(400, 'statuses must be an object of status id: rules');
    for (const [sid, rule] of Object.entries(b.statuses)) {
      if (!ids.has(sid)) fail(400, 'Unknown status in rules');
      if (!rule || typeof rule !== 'object') continue;
      const name = nameOf(sid);
      const required = [];
      for (const r of Array.isArray(rule.required) ? rule.required : []) {
        const k = String(r);
        if (REQUIRABLE[k]) required.push(k);
        else if (k.startsWith('cf:')) {
          const f = (await fieldsOf()).find((x) => x.id === k.slice(3) && !x.archived);
          if (!f) fail(400, `${name}: unknown custom field`);
          required.push(k);
        } else fail(400, `${name}: unknown required value ${k}`);
      }
      const a = rule.actions && typeof rule.actions === 'object' ? rule.actions : {};
      const actions = {};
      if (a.assignee && a.assignee.to) {
        if (!ASSIGN_TO.includes(a.assignee.to)) fail(400, `${name}: assignee must be one of ${ASSIGN_TO.join(', ')}`);
        if (a.assignee.to === 'user') {
          const u = await db.get(`SELECT id, name, role FROM users WHERE id = ? AND status <> 'deactivated'`, [a.assignee.userId || '']);
          if (!u) fail(400, `${name}: the person to assign was not found`);
          if (!(await userCanSee(db, project, u))) fail(400, `${name}: ${u.name} cannot see this project`);
          actions.assignee = { to: 'user', userId: u.id };
        } else actions.assignee = { to: a.assignee.to };
      }
      const add = cleanLabelList(a.addLabels, `${name}: labels to add`);
      const remove = cleanLabelList(a.removeLabels, `${name}: labels to remove`);
      if (add.length) actions.addLabels = add;
      if (remove.length) actions.removeLabels = remove;
      if (a.field && a.field.fieldId) {
        const f = (await fieldsOf()).find((x) => x.id === a.field.fieldId && !x.archived);
        if (!f) fail(400, `${name}: unknown custom field`);
        await readFieldValues(db, project.id, { [f.id]: a.field.value ?? null }, { fields: await fieldsOf() }); // valid value?
        actions.field = { fieldId: f.id, value: a.field.value ?? null };
      }
      const comment = str(a.comment, { max: MAX_TEXT, name: `${name}: comment` });
      if (comment) actions.comment = comment;
      if (a.sprint) {
        if (!['active', 'backlog'].includes(a.sprint)) fail(400, `${name}: sprint must be active or backlog`);
        actions.sprint = a.sprint;
      }
      const notify = str(a.notify, { max: 500, name: `${name}: watcher message` });
      if (notify) actions.notify = notify;
      if (required.length || Object.keys(actions).length) out.statuses[sid] = { required: [...new Set(required)], actions };
    }
  }
  return hasRules(out) || !out.adminBypass ? JSON.stringify(out) : null;
}

/** The workflow without a deleted status (used when a status is deleted). */
export function withoutStatus(text, statusId) {
  const wf = parseWorkflow(text);
  if (!hasRules(wf)) return text ?? null;
  if (wf.transitions) {
    delete wf.transitions[statusId];
    for (const k of Object.keys(wf.transitions)) wf.transitions[k] = wf.transitions[k].filter((x) => x !== statusId);
  }
  delete wf.statuses[statusId];
  return JSON.stringify(wf);
}

export const fillTemplate = (text, vars) => String(text).replace(/\{(user|status|key|title)\}/g, (_, k) => vars[k] ?? '');

/**
 * Before a status change in updateIssue. Checks the transition (400 with the allowed statuses) and merges the
 * automations of the new status into the PATCH body (values the caller sent win). Returns
 * { body, toStatus, required, comment, notify, autoSprint } or null when the project has no rules.
 */
export async function prepareTransition(db, { project, access, user, current, b }) {
  const wf = parseWorkflow(project.workflow);
  if (!hasRules(wf)) return null;
  const statuses = await db.all('SELECT id, name FROM statuses WHERE project_id = ? ORDER BY position', [project.id]);
  const from = statuses.find((s) => s.id === current.status_id);
  const to = statuses.find((s) => s.id === b.statusId);
  if (!to) return null; // the normal path answers "Status not found"
  if (!transitionAllowed(wf, current.status_id, to.id) && !(access.canAdmin && wf.adminBypass)) {
    const allowed = (wf.transitions[current.status_id] || []).map((id) => statuses.find((s) => s.id === id)).filter(Boolean);
    fail(
      400,
      refusalText(
        from?.name,
        to.name,
        allowed.map((s) => s.name),
      ),
      {
        code: 'transition',
        allowed: allowed.map((s) => s.id),
      },
    );
  }
  const rule = wf.statuses[to.id] || {};
  const a = rule.actions || {};
  const body = { ...b };
  let autoSprint = false;
  if (a.assignee && body.assigneeId === undefined) {
    const target =
      a.assignee.to === 'clear'
        ? null
        : a.assignee.to === 'reporter'
          ? current.reporter_id
          : a.assignee.to === 'actor'
            ? user.id
            : a.assignee.userId;
    if (target === null) body.assigneeId = null;
    else if (target) {
      const u = await db.get(`SELECT id, role FROM users WHERE id = ? AND status <> 'deactivated'`, [target]);
      if (u && (await userCanSee(db, project, u))) body.assigneeId = u.id; // someone gone or not allowed: skipped
    }
  }
  if (a.addLabels || a.removeLabels) {
    const base = Array.isArray(body.labels)
      ? body.labels
      : (await db.all('SELECT label FROM issue_labels WHERE issue_id = ?', [current.id])).map((r) => r.label);
    const drop = new Set(a.removeLabels || []);
    body.labels = [...new Set([...base, ...(a.addLabels || [])])].filter((l) => !drop.has(l)).slice(0, 20);
  }
  if (a.field && !(body.fields && typeof body.fields === 'object' && Object.prototype.hasOwnProperty.call(body.fields, a.field.fieldId))) {
    try {
      const fields = await listFields(db, project.id);
      const f = fields.find((x) => x.id === a.field.fieldId && !x.archived);
      if (f && appliesTo(f, body.type || current.type)) {
        await readFieldValues(db, project.id, { [f.id]: a.field.value }, { fields });
        body.fields = { ...(body.fields && typeof body.fields === 'object' ? body.fields : {}), [f.id]: a.field.value };
      }
    } catch {
      /* an option or person removed since the rule was saved: skip this automation */
    }
  }
  if (a.sprint && body.sprintId === undefined) {
    if (a.sprint === 'backlog') {
      if (current.sprint_id) {
        body.sprintId = null;
        autoSprint = true;
      }
    } else {
      const sp = await db.get(`SELECT id FROM sprints WHERE project_id = ? AND state = 'active'`, [project.id]);
      if (sp && sp.id !== current.sprint_id) {
        body.sprintId = sp.id;
        autoSprint = true;
      }
    }
  }
  const vars = { user: user.name, status: to.name, key: current.key, title: body.title || current.title };
  return {
    body,
    toStatus: to,
    required: Array.isArray(rule.required) ? rule.required : [],
    comment: a.comment ? fillTemplate(a.comment, vars).slice(0, 20000) : null,
    notify: a.notify ? fillTemplate(a.notify, vars).slice(0, 1000) : null,
    autoSprint,
  };
}

/**
 * Required values of the new status that the issue will not have after this change. `after` holds the final column
 * values (assignee_id, story_points, due_date, estimate_hours); b is the PATCH body; fieldValues the custom field
 * values this change sets (Map fieldId -> text | null). Returns [{ key, label, fieldId?, type? }].
 */
export async function requiredMissing(db, { required, current, after, b, fieldValues, type }) {
  if (!required.length) return [];
  const missing = [];
  const empty = (v) => v === null || v === undefined || v === '';
  let fields = null;
  let values = null;
  for (const k of required) {
    if (k === 'assignee' && empty(after.assignee_id)) missing.push({ key: k, label: REQUIRABLE[k] });
    else if (k === 'storyPoints' && empty(after.story_points)) missing.push({ key: k, label: REQUIRABLE[k] });
    else if (k === 'dueDate' && empty(after.due_date)) missing.push({ key: k, label: REQUIRABLE[k] });
    else if (k === 'estimate' && empty(after.estimate_hours)) missing.push({ key: k, label: REQUIRABLE[k] });
    else if (k === 'comment' && !(typeof b.comment === 'string' && b.comment.trim())) missing.push({ key: k, label: REQUIRABLE[k] });
    else if (k === 'fixVersion' || k === 'components') {
      const prop = k === 'fixVersion' ? 'fixVersions' : 'components';
      const has =
        b[prop] !== undefined
          ? Array.isArray(b[prop])
            ? b[prop].length > 0
            : Boolean(b[prop])
          : (await currentIds(db, current.id, prop)).length > 0;
      if (!has) missing.push({ key: k, label: REQUIRABLE[k] });
    } else if (k.startsWith('cf:')) {
      fields ||= await listFields(db, current.project_id);
      const f = fields.find((x) => x.id === k.slice(3) && !x.archived);
      if (!f || !appliesTo(f, type)) continue;
      let v = fieldValues?.has(f.id) ? fieldValues.get(f.id) : undefined;
      if (v === undefined) v = (values ||= await issueValues(db, current.id)).get(f.id);
      if (empty(v) || v === '[]') missing.push({ key: k, label: f.name, fieldId: f.id, type: f.type });
    }
  }
  return missing;
}
