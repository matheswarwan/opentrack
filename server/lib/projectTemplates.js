// Project templates: a new project can start from one (POST /api/projects with templateId and startDate).
// Built-in templates live in projectTemplates/builtins.js; saved ones in the project_templates table (migration 0024), made from an
// existing project with "Save as template" (projectToBody). Routes: server/routes/projectTemplates.js.
//
// A template body (JSON) refers to things by name, never by id, so it can be applied to any new project:
//   statuses:       [{ name, category: todo|in_progress|done, wipLimit }] in board order (the first is where new issues start)
//   workflow:       null or { transitions: null | { <status name>: [<status name>] }, adminBypass,
//                     statuses: { <status name>: { required: [assignee, storyPoints, dueDate, estimate, fixVersion,
//                     components, comment, 'field:<field name>'], actions: { assignee: { to: reporter|actor|clear|role,
//                     role }, addLabels, removeLabels, field: { field: <name>, value }, comment, sprint, notify } } } }
//                   (the same rules as server/lib/workflow.js, by name)
//   fields:         [{ name, type, options: [names], required, help, issueTypes }] (custom fields; no person fields' values)
//   components:     [{ name, description, lead: role|null, defaultAssignee: role|null }]
//   issueTemplates: [{ name, type, titlePrefix, description, priority, labels, subtasks, fields: { <field name>: value },
//                     components: [names] }]
//   recurring:      [{ name, title, type, description, priority, labels, subtasks, template: <issue template name>,
//                     sprint, dueDays, schedule, start: 'day N', assignee: role|null }]
//   permissions:    { delete, sprints, create, comment } (server/lib/access.js PROJECT_PERMS)
//   labels:         labels the project uses (shown in the picker; they are added to issues by the starter issues)
//   issues:         [{ ref, type: epic|story|task|bug, title, description, priority, labels, parent: <ref of an epic>,
//                     due: 'day N'|'week N', start: 'day N'|'week N', storyPoints, assignee: role|null, components: [names],
//                     sprint: true (put in the first sprint) }]
//   sprint:         null or { name, goal, start: 'day N'|'week N', lengthDays } (a future sprint)
//
// Relative dates count from the project start date: 'day 1' is the start date, 'day 10' nine days later, and
// 'week N' is the fifth day of week N (the Friday when the project starts on a Monday).
// Roles stand in for people: 'lead' (the project lead) and 'creator' (the person who creates the project). A saved
// template never holds user ids, comments, history or members.
//
// Applying makes few statements (D1: about 50 queries per request, at most 100 bound values per query): rows go in
// multi-row INSERTs, text is bound and the app's own values (ids, timestamps, numbers, enums) are written as
// checked literals (lit), so a whole template is one batch of about 20 statements.
import { fail } from './http.js';
import { uuid } from './crypto.js';
import { addDays } from './time.js';
import { FIELD_TYPES, OPTION_TYPES, MAX_FIELDS, MAX_OPTIONS, listFields } from './customFields.js';
import { PROJECT_PERMS } from './access.js';
import { REQUIRABLE, parseWorkflow } from './workflow.js';
import { readSchedule } from './recurring.js';
import { TYPES, PRIORITIES, RANK_STEP, STATUS_CATEGORIES } from './issues/model.js';
import { placeholders, chunks } from '../db/sql.js';
import { parseList, parseObject } from './json.js';

export const ROLES = { lead: 'Project lead', creator: 'Person who creates the project' };
export const MAX_SAVED_PER_USER = 50;
export const MAX_BODY_BYTES = 200000;
const LIMITS = { statuses: 20, components: 100, issueTemplates: 50, recurring: 20, issues: 150, labels: 50 };
const ISSUE_TYPES = ['epic', 'story', 'task', 'bug']; // starter issues (no sub-tasks)
const ASSIGN_TO = ['reporter', 'actor', 'clear', 'role'];
const ROWS = 40; // rows per INSERT

// ---------- validation ----------

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const list = (v, name, max) => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail(400, `Template: ${name} must be a list`);
  if (v.length > max) fail(400, `Template: at most ${max} ${name}`);
  return v;
};
const text = (v, name, max, required = false) => {
  if (v === undefined || v === null || v === '') {
    if (required) fail(400, `Template: ${name} is required`);
    return null;
  }
  if (typeof v !== 'string') fail(400, `Template: ${name} must be text`);
  const t = v.trim();
  if (required && !t) fail(400, `Template: ${name} is required`);
  if (t.length > max) fail(400, `Template: ${name} is too long (max ${max} characters)`);
  return t || null;
};
const pick = (v, values, name, dflt) => {
  if (v === undefined || v === null || v === '') return dflt;
  if (!values.includes(v)) fail(400, `Template: ${name} must be one of ${values.join(', ')}`);
  return v;
};
const role = (v, name) => (v === undefined || v === null || v === '' ? null : pick(v, Object.keys(ROLES), name, null));
const labelList = (v, name) => {
  const out = [
    ...new Set(
      list(v, name, 20)
        .map((l) => String(l).trim().replace(/\s+/g, '-'))
        .filter(Boolean),
    ),
  ];
  if (out.some((l) => l.length > 40)) fail(400, `Template: ${name} are at most 40 characters`);
  return out;
};
const titleList = (v, name, max = 20) => {
  const out = list(v, name, max)
    .map((s) => String(s).trim())
    .filter(Boolean);
  if (out.some((s) => s.length > 255)) fail(400, `Template: ${name} are at most 255 characters`);
  return out;
};

/** 'day N' / 'week N' -> days after the start date (day 1 = 0). Returns null for empty. */
export function relOffset(v, name = 'date') {
  if (v === undefined || v === null || v === '') return null;
  const m = /^(day|week)\s+(\d{1,3})$/i.exec(String(v).trim());
  if (!m) fail(400, `Template: ${name} must look like "day 10" or "week 6"`);
  const n = Number(m[2]);
  if (m[1].toLowerCase() === 'day') {
    if (n < 1 || n > 730) fail(400, `Template: ${name} must be day 1 to day 730`);
    return n - 1;
  }
  if (n < 1 || n > 104) fail(400, `Template: ${name} must be week 1 to week 104`);
  return (n - 1) * 7 + 4;
}
const rel = (v, name) => {
  relOffset(v, name);
  return v === undefined || v === null || v === '' ? null : String(v).trim().toLowerCase().replace(/\s+/, ' ');
};

/** A field value in template form (option names, plain values) checked against the field definition. */
function fieldValue(f, v, where) {
  if (v === undefined || v === null || v === '') return null;
  switch (f.type) {
    case 'select':
      if (!f.options.some((o) => o.toLowerCase() === String(v).toLowerCase()))
        fail(400, `Template: ${where}: ${f.name} has no option ${v}`);
      return String(v);
    case 'multiselect': {
      const vs = Array.isArray(v) ? v.map(String) : [String(v)];
      for (const x of vs)
        if (!f.options.some((o) => o.toLowerCase() === x.toLowerCase())) fail(400, `Template: ${where}: ${f.name} has no option ${x}`);
      return vs;
    }
    case 'checkbox':
      return Boolean(v);
    case 'number':
      if (!Number.isFinite(Number(v))) fail(400, `Template: ${where}: ${f.name} must be a number`);
      return Number(v);
    case 'user':
      return null; // people are never kept in a template
    default:
      if (typeof v !== 'string' || v.length > 2000) fail(400, `Template: ${where}: ${f.name} must be text`);
      return v;
  }
}

// ---- the parts of a template body, in the order readBody checks them (the first problem found is the one reported) ----

// Lookups by name in what was read so far (`out`), ignoring case.
const statusLookup = (out) => (n) => out.statuses.find((s) => s.name.toLowerCase() === String(n).toLowerCase())?.name;
const fieldLookup = (out) => (n) => out.fields.find((f) => f.name.toLowerCase() === String(n).toLowerCase());
const componentLookup = (out) => (v, where) => [
  ...new Set(
    list(v, `components of ${where}`, 20).map((x) => {
      const c = out.components.find((y) => y.name.toLowerCase() === String(x).toLowerCase());
      if (!c) fail(400, `Template: ${where}: unknown component ${x}`);
      return c.name;
    }),
  ),
];

function readStatuses(raw) {
  const seen = new Set();
  const statuses = list(raw.statuses, 'statuses', LIMITS.statuses).map((s, i) => {
    if (!isObj(s)) fail(400, 'Template: each status needs a name');
    const name = text(s.name, `status ${i + 1} name`, 40, true);
    if (seen.has(name.toLowerCase())) fail(400, `Template: the status ${name} is listed twice`);
    seen.add(name.toLowerCase());
    const w = s.wipLimit === undefined || s.wipLimit === null || s.wipLimit === '' ? null : Number(s.wipLimit);
    if (w !== null && (!Number.isInteger(w) || w < 0 || w > 999)) fail(400, `Template: WIP limit of ${name} must be 0 to 999`);
    return { name, category: pick(s.category, STATUS_CATEGORIES, `category of ${name}`, 'in_progress'), wipLimit: w };
  });
  if (!statuses.length) fail(400, 'Template: add at least one status');
  if (!statuses.some((s) => s.category === 'done')) fail(400, 'Template: one status must have the category done');
  return statuses;
}

function readFields(raw) {
  const fnames = new Set();
  return list(raw.fields, 'fields', MAX_FIELDS).map((f, i) => {
    if (!isObj(f)) fail(400, 'Template: each field needs a name');
    const name = text(f.name, `field ${i + 1} name`, 60, true);
    if (fnames.has(name.toLowerCase())) fail(400, `Template: the field ${name} is listed twice`);
    fnames.add(name.toLowerCase());
    const type = pick(f.type, FIELD_TYPES, `type of ${name}`, null);
    if (!type) fail(400, `Template: type of ${name} is required`);
    let options = [];
    if (OPTION_TYPES.includes(type)) {
      options = [
        ...new Set(
          list(f.options, `options of ${name}`, MAX_OPTIONS).map((o) => text(isObj(o) ? o.name : o, `option of ${name}`, 80, true)),
        ),
      ];
      if (!options.length) fail(400, `Template: ${name} needs at least one option`);
    }
    const issueTypes = list(f.issueTypes, `issue types of ${name}`, 5).map((t) => pick(t, TYPES, `issue types of ${name}`, null));
    return { name, type, options, required: Boolean(f.required), help: text(f.help, `help of ${name}`, 300), issueTypes };
  });
}

/** Workflow rules, named by status and field (out.statuses, out.fields); null when there are none. */
function readWorkflow(raw, out) {
  const statusName = statusLookup(out);
  const fieldNamed = fieldLookup(out);
  if (!isObj(raw.workflow)) return null;
  const wf = { transitions: null, adminBypass: raw.workflow.adminBypass !== false, statuses: {} };
  if (isObj(raw.workflow.transitions)) {
    wf.transitions = {};
    for (const [from, to] of Object.entries(raw.workflow.transitions)) {
      const f = statusName(from);
      if (!f) fail(400, `Template: workflow names an unknown status ${from}`);
      wf.transitions[f] = [
        ...new Set(
          list(to, `moves from ${f}`, LIMITS.statuses).map((x) => {
            const n = statusName(x);
            if (!n) fail(400, `Template: workflow names an unknown status ${x}`);
            return n;
          }),
        ),
      ].filter((x) => x !== f);
    }
  }
  if (isObj(raw.workflow.statuses)) {
    for (const [sname, rule] of Object.entries(raw.workflow.statuses)) {
      const n = statusName(sname);
      if (!n) fail(400, `Template: workflow names an unknown status ${sname}`);
      if (!isObj(rule)) continue;
      const required = [
        ...new Set(
          list(rule.required, `required values of ${n}`, 20).map((k) => {
            if (REQUIRABLE[k]) return k;
            if (typeof k === 'string' && k.startsWith('field:') && fieldNamed(k.slice(6))) return `field:${fieldNamed(k.slice(6)).name}`;
            fail(400, `Template: ${n}: unknown required value ${k}`);
          }),
        ),
      ];
      const a = isObj(rule.actions) ? rule.actions : {};
      const actions = {};
      if (isObj(a.assignee) && a.assignee.to) {
        const to = pick(a.assignee.to, ASSIGN_TO, `${n}: assignee`, null);
        if (to === 'role') {
          const r = role(a.assignee.role, `${n}: assignee role`);
          if (r) actions.assignee = { to, role: r };
        } else actions.assignee = { to };
      }
      const add = labelList(a.addLabels, `${n}: labels to add`);
      const remove = labelList(a.removeLabels, `${n}: labels to remove`);
      if (add.length) actions.addLabels = add;
      if (remove.length) actions.removeLabels = remove;
      if (isObj(a.field) && a.field.field) {
        const f = fieldNamed(a.field.field);
        if (!f) fail(400, `Template: ${n}: unknown field ${a.field.field}`);
        const value = fieldValue(f, a.field.value, n);
        if (value !== null) actions.field = { field: f.name, value };
      }
      const comment = text(a.comment, `${n}: comment`, 2000);
      if (comment) actions.comment = comment;
      if (a.sprint) actions.sprint = pick(a.sprint, ['active', 'backlog'], `${n}: sprint`, null);
      const notify = text(a.notify, `${n}: watcher message`, 500);
      if (notify) actions.notify = notify;
      if (required.length || Object.keys(actions).length) wf.statuses[n] = { required, actions };
    }
  }
  return wf.transitions || Object.keys(wf.statuses).length || !wf.adminBypass ? wf : null;
}

function readComponents(raw) {
  const cnames = new Set();
  return list(raw.components, 'components', LIMITS.components).map((c, i) => {
    if (!isObj(c)) fail(400, 'Template: each component needs a name');
    const name = text(c.name, `component ${i + 1} name`, 80, true);
    if (cnames.has(name.toLowerCase())) fail(400, `Template: the component ${name} is listed twice`);
    cnames.add(name.toLowerCase());
    return {
      name,
      description: text(c.description, `description of ${name}`, 1000),
      lead: role(c.lead, `lead of ${name}`),
      defaultAssignee: role(c.defaultAssignee, `default assignee of ${name}`),
    };
  });
}

function readIssueTemplates(raw, out) {
  const fieldNamed = fieldLookup(out);
  const componentList = componentLookup(out);
  const tnames = new Set();
  return list(raw.issueTemplates, 'issue templates', LIMITS.issueTemplates).map((t, i) => {
    if (!isObj(t)) fail(400, 'Template: each issue template needs a name');
    const name = text(t.name, `issue template ${i + 1} name`, 80, true);
    if (tnames.has(name.toLowerCase())) fail(400, `Template: the issue template ${name} is listed twice`);
    tnames.add(name.toLowerCase());
    const type = pick(t.type, TYPES, `type of ${name}`, 'task');
    const subtasks = titleList(t.subtasks, `sub-tasks of ${name}`);
    if (subtasks.length && !['story', 'task', 'bug'].includes(type))
      fail(400, `Template: ${name}: only story, task and bug templates can have sub-tasks`);
    const fields = {};
    for (const [k, v] of Object.entries(isObj(t.fields) ? t.fields : {})) {
      const f = fieldNamed(k);
      if (!f) fail(400, `Template: ${name}: unknown field ${k}`);
      const value = fieldValue(f, v, name);
      if (value !== null) fields[f.name] = value;
    }
    const prefix = typeof t.titlePrefix === 'string' ? t.titlePrefix.replace(/^\s+/, '') : '';
    if (prefix.length > 100) fail(400, `Template: title prefix of ${name} is too long`);
    return {
      name,
      type,
      titlePrefix: prefix || null,
      description: text(t.description, `description of ${name}`, 50000),
      priority: pick(t.priority, PRIORITIES, `priority of ${name}`, null),
      labels: labelList(t.labels, `labels of ${name}`),
      subtasks,
      fields,
      components: componentList(t.components, name),
    };
  });
}

function readRecurring(raw, out) {
  return list(raw.recurring, 'recurring rules', LIMITS.recurring).map((r, i) => {
    if (!isObj(r)) fail(400, 'Template: each recurring rule needs a title');
    const title = text(r.title, `recurring rule ${i + 1} title`, 255, true);
    const name = text(r.name, `name of ${title}`, 80) || title.slice(0, 80);
    const type = pick(r.type, ['epic', 'story', 'task', 'bug'], `type of ${name}`, 'task');
    const subtasks = titleList(r.subtasks, `sub-tasks of ${name}`);
    if (subtasks.length && type === 'epic') fail(400, `Template: ${name}: an epic cannot have sub-tasks`);
    let template = null;
    if (r.template) {
      template = out.issueTemplates.find((t) => t.name.toLowerCase() === String(r.template).toLowerCase())?.name;
      if (!template) fail(400, `Template: ${name}: unknown issue template ${r.template}`);
    }
    const dueDays = r.dueDays === undefined || r.dueDays === null || r.dueDays === '' ? null : Number(r.dueDays);
    if (dueDays !== null && (!Number.isInteger(dueDays) || dueDays < 0 || dueDays > 365))
      fail(400, `Template: ${name}: due after must be 0 to 365 days`);
    let schedule;
    try {
      schedule = readSchedule(r.schedule);
    } catch (e) {
      fail(400, `Template: ${name}: ${e.message}`);
    }
    return {
      name,
      title,
      type,
      description: text(r.description, `description of ${name}`, 50000),
      priority: pick(r.priority, PRIORITIES, `priority of ${name}`, 'medium'),
      labels: labelList(r.labels, `labels of ${name}`),
      subtasks,
      template,
      sprint: pick(r.sprint, ['backlog', 'active'], `sprint of ${name}`, 'backlog'),
      dueDays,
      schedule,
      start: rel(r.start, `start of ${name}`),
      assignee: role(r.assignee, `assignee of ${name}`),
    };
  });
}

function readPermissions(raw) {
  const permissions = {};
  if (isObj(raw.permissions)) {
    for (const [k, v] of Object.entries(raw.permissions)) {
      if (!PROJECT_PERMS[k]) fail(400, `Template: unknown permission ${k}`);
      permissions[k] = pick(v, PROJECT_PERMS[k].values, `permission ${k}`, PROJECT_PERMS[k].values[0]);
    }
  }
  return permissions;
}

function readSprint(raw) {
  if (!isObj(raw.sprint)) return null;
  const len = raw.sprint.lengthDays === undefined ? 14 : Number(raw.sprint.lengthDays);
  if (!Number.isInteger(len) || len < 1 || len > 90) fail(400, 'Template: sprint length must be 1 to 90 days');
  return {
    name: text(raw.sprint.name, 'sprint name', 80) || 'Sprint 1',
    goal: text(raw.sprint.goal, 'sprint goal', 1000),
    start: rel(raw.sprint.start, 'sprint start') || 'day 1',
    lengthDays: len,
  };
}

/** Starter issues: epics before their children. */
function readIssues(raw, out) {
  const componentList = componentLookup(out);
  const refs = new Map();
  const issues = list(raw.issues, 'starter issues', LIMITS.issues).map((x, i) => {
    if (!isObj(x)) fail(400, 'Template: each starter issue needs a title');
    const title = text(x.title, `starter issue ${i + 1} title`, 255, true);
    const ref = text(x.ref == null ? `i${i + 1}` : String(x.ref), `ref of ${title}`, 40, true);
    if (refs.has(ref)) fail(400, `Template: the starter issue ref ${ref} is used twice`);
    const type = pick(x.type, ISSUE_TYPES, `type of ${title}`, 'task');
    const sp = x.storyPoints === undefined || x.storyPoints === null || x.storyPoints === '' ? null : Number(x.storyPoints);
    if (sp !== null && (!Number.isFinite(sp) || sp < 0 || sp > 1000)) fail(400, `Template: story points of ${title} must be 0 to 1000`);
    const issue = {
      ref,
      type,
      title,
      description: text(x.description, `description of ${title}`, 50000),
      priority: pick(x.priority, PRIORITIES, `priority of ${title}`, 'medium'),
      labels: labelList(x.labels, `labels of ${title}`),
      parent: x.parent ? String(x.parent) : null,
      due: rel(x.due, `due date of ${title}`),
      start: rel(x.start, `start of ${title}`),
      storyPoints: sp,
      assignee: role(x.assignee, `assignee of ${title}`),
      components: componentList(x.components, title),
      sprint: Boolean(x.sprint) && Boolean(out.sprint),
    };
    refs.set(ref, issue);
    return issue;
  });
  for (const x of issues) {
    if (!x.parent) continue;
    const p = refs.get(x.parent);
    if (!p) fail(400, `Template: the parent of ${x.title} is not in the template`);
    if (x.type === 'epic' || p.type !== 'epic') fail(400, `Template: ${x.title}: only epics can be parents of stories, tasks and bugs`);
  }
  return [...issues.filter((x) => x.type === 'epic'), ...issues.filter((x) => x.type !== 'epic')];
}

/** Check and clean a template body (built-in, saved or restored). Returns a new object in the documented shape. */
export function readBody(raw) {
  if (!isObj(raw)) fail(400, 'Template body must be an object');
  const out = {};
  out.statuses = readStatuses(raw);
  out.fields = readFields(raw);
  out.workflow = readWorkflow(raw, out);
  out.components = readComponents(raw);
  out.issueTemplates = readIssueTemplates(raw, out);
  out.recurring = readRecurring(raw, out);
  out.permissions = readPermissions(raw);
  out.labels = [
    ...new Set(
      list(raw.labels, 'labels', LIMITS.labels)
        .map((l) => String(l).trim().replace(/\s+/g, '-'))
        .filter((l) => l && l.length <= 40),
    ),
  ];
  out.sprint = readSprint(raw);
  out.issues = readIssues(raw, out);
  return out;
}

/** What a template sets up, for the picker and the result message. */
export function bodySummary(b) {
  const n = (t) => b.issues.filter((x) => x.type === t).length;
  return {
    statuses: b.statuses.map((s) => s.name),
    workflowRules: Boolean(b.workflow),
    fields: b.fields.map((f) => f.name),
    components: b.components.length,
    issueTemplates: b.issueTemplates.map((t) => t.name),
    recurring: b.recurring.map((r) => r.name),
    labels: b.labels,
    epics: n('epic'),
    stories: n('story'),
    tasks: n('task'),
    bugs: n('bug'),
    sprint: b.sprint ? b.sprint.name : null,
    permissions: Object.keys(b.permissions).length > 0,
  };
}

// ---------- applying ----------

const SAFE = /^[A-Za-z0-9:._+-]{0,100}$/;
/** A value written into SQL text: only the app's own ids, timestamps, dates, enums and numbers (never user text). */
export function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('lit: not a finite number');
    return String(v);
  }
  if (typeof v === 'string' && SAFE.test(v)) return `'${v}'`;
  throw new Error('lit: unsafe value');
}
const B = (v) => ({ bind: v ?? null }); // a bound value (user text)

/** Multi-row INSERTs, at most ROWS rows and 90 bound values per statement. Values: B(x) to bind, else lit(x). */
export function insertLiteralRows(table, cols, rows) {
  const out = [];
  let sql = [];
  let params = [];
  const flush = () => {
    if (!sql.length) return;
    out.push({ sql: `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${sql.join(', ')}`, params });
    sql = [];
    params = [];
  };
  for (const row of rows) {
    const binds = row.filter((v) => v && typeof v === 'object' && 'bind' in v).length;
    if (sql.length >= ROWS || params.length + binds > 90) flush();
    sql.push(`(${row.map((v) => (v && typeof v === 'object' && 'bind' in v ? (params.push(v.bind), '?') : lit(v))).join(', ')})`);
  }
  flush();
  return out;
}

const optionIds = (f, value) => {
  const id = (name) => f.options.find((o) => o.name.toLowerCase() === String(name).toLowerCase())?.id;
  if (f.type === 'select') return id(value) ?? null;
  if (f.type === 'multiselect') return (Array.isArray(value) ? value : [value]).map(id).filter(Boolean);
  return value;
};

/**
 * The plan for a new project from a template body (already read by readBody).
 * Returns { statuses: [{ id, name, category, wipLimit }], project: { workflow, perm cols, issue_seq }, stmts, summary }.
 * The caller inserts the project row (with `project` columns) and the statuses, then runs stmts in the same batch.
 */
export function planTemplate(body, { projectId, projectKey, creatorId, leadId, startDate, t }) {
  const people = { lead: leadId, creator: creatorId };
  const who = (r) => (r ? people[r] || null : null);
  const at = (relDate) => (relDate ? addDays(startDate, relOffset(relDate)) : null);
  const stmts = [];

  const statuses = body.statuses.map((s, i) => ({ id: uuid(), name: s.name, category: s.category, wipLimit: s.wipLimit, position: i }));
  const sid = (name) => statuses.find((s) => s.name === name)?.id;

  // custom fields with fresh option ids
  const fields = body.fields.map((f, i) => ({
    ...f,
    id: uuid(),
    position: i,
    options: f.options.map((name) => ({ id: uuid(), name, archived: false })),
  }));
  const fieldNamed = (n) => fields.find((f) => f.name === n);
  stmts.push(
    ...insertLiteralRows(
      'custom_fields',
      [
        'id',
        'project_id',
        'name',
        'type',
        'options',
        'required',
        'help',
        'issue_types',
        'position',
        'archived',
        'created_at',
        'updated_at',
      ],
      fields.map((f) => [
        f.id,
        projectId,
        B(f.name),
        f.type,
        B(JSON.stringify(f.options)),
        f.required ? 1 : 0,
        B(f.help),
        B(JSON.stringify(f.issueTypes)),
        f.position,
        0,
        t,
        t,
      ]),
    ),
  );

  // workflow rules by id
  let workflow = null;
  if (body.workflow) {
    const wf = { transitions: null, adminBypass: body.workflow.adminBypass, statuses: {} };
    if (body.workflow.transitions) {
      wf.transitions = {};
      for (const [from, to] of Object.entries(body.workflow.transitions)) wf.transitions[sid(from)] = to.map(sid);
    }
    for (const [name, rule] of Object.entries(body.workflow.statuses)) {
      const required = rule.required.map((k) => (k.startsWith('field:') ? `cf:${fieldNamed(k.slice(6)).id}` : k));
      const actions = {};
      for (const [k, v] of Object.entries(rule.actions || {})) {
        if (k === 'assignee') {
          if (v.to !== 'role') actions.assignee = { to: v.to };
          else if (who(v.role)) actions.assignee = { to: 'user', userId: who(v.role) };
        } else if (k === 'field') {
          const f = fieldNamed(v.field);
          actions.field = { fieldId: f.id, value: optionIds(f, v.value) };
        } else actions[k] = v;
      }
      wf.statuses[sid(name)] = { required, actions };
    }
    workflow = JSON.stringify(wf);
  }

  // components
  const components = body.components.map((c) => ({ ...c, id: uuid() }));
  const cid = (name) => components.find((c) => c.name === name)?.id;
  stmts.push(
    ...insertLiteralRows(
      'components',
      ['id', 'project_id', 'name', 'description', 'lead_id', 'default_assignee_id', 'created_at', 'updated_at'],
      components.map((c) => [c.id, projectId, B(c.name), B(c.description), who(c.lead), who(c.defaultAssignee), t, t]),
    ),
  );

  // issue templates
  const templates = body.issueTemplates.map((x, i) => ({ ...x, id: uuid(), position: i }));
  const fieldsJson = (values) => {
    const o = {};
    for (const [name, v] of Object.entries(values)) {
      const f = fieldNamed(name);
      if (f) o[f.id] = optionIds(f, v);
    }
    return JSON.stringify(o);
  };
  stmts.push(
    ...insertLiteralRows(
      'issue_templates',
      [
        'id',
        'project_id',
        'name',
        'type',
        'title_prefix',
        'description',
        'priority',
        'labels',
        'subtasks',
        'fields',
        'components',
        'position',
        'created_by',
        'created_at',
        'updated_at',
      ],
      templates.map((x) => [
        x.id,
        projectId,
        B(x.name),
        x.type,
        B(x.titlePrefix),
        B(x.description),
        x.priority,
        B(JSON.stringify(x.labels)),
        B(JSON.stringify(x.subtasks)),
        B(fieldsJson(x.fields)),
        B(JSON.stringify(x.components.map(cid))),
        x.position,
        creatorId,
        t,
        t,
      ]),
    ),
  );

  // recurring rules (start on the project start date unless the rule says later)
  stmts.push(
    ...insertLiteralRows(
      'recurring_rules',
      [
        'id',
        'project_id',
        'name',
        'title',
        'type',
        'description',
        'priority',
        'assignee_id',
        'labels',
        'template_id',
        'subtasks',
        'sprint',
        'due_days',
        'schedule',
        'start_date',
        'created_by',
        'created_at',
        'updated_at',
      ],
      body.recurring.map((r) => [
        uuid(),
        projectId,
        B(r.name),
        B(r.title),
        r.type,
        B(r.description),
        r.priority,
        who(r.assignee),
        B(JSON.stringify(r.labels)),
        r.template ? (templates.find((x) => x.name === r.template)?.id ?? null) : null,
        B(JSON.stringify(r.subtasks)),
        r.sprint,
        r.dueDays,
        B(JSON.stringify(r.schedule)),
        at(r.start) || startDate,
        creatorId,
        t,
        t,
      ]),
    ),
  );

  // first sprint (future)
  let sprintId = null;
  if (body.sprint) {
    sprintId = uuid();
    const start = at(body.sprint.start) || startDate;
    stmts.push({
      sql: `INSERT INTO sprints (id, project_id, name, goal, state, start_date, end_date, created_at) VALUES (${lit(sprintId)}, ${lit(projectId)}, ?, ?, 'future', ${lit(start)}, ${lit(addDays(start, body.sprint.lengthDays - 1))}, ${lit(t)})`,
      params: [body.sprint.name, body.sprint.goal],
    });
  }

  // starter issues
  const first = statuses[0];
  const ids = new Map(body.issues.map((x) => [x.ref, uuid()]));
  const issueRows = [];
  const history = [];
  const labels = [];
  const watchers = [];
  const comps = [];
  body.issues.forEach((x, i) => {
    const id = ids.get(x.ref);
    const number = i + 1;
    const key = `${projectKey}-${number}`;
    const assignee = who(x.assignee);
    issueRows.push([
      id,
      projectId,
      number,
      key,
      x.type,
      B(x.title),
      B(x.description),
      first.id,
      x.priority,
      assignee,
      creatorId,
      x.parent ? ids.get(x.parent) : null,
      x.sprint ? sprintId : null,
      x.storyPoints,
      at(x.due),
      at(x.start),
      RANK_STEP * (i + 1),
      t,
      t,
      first.category === 'done' ? t : null,
    ]);
    history.push([uuid(), id, creatorId, 'created', null, key, t]);
    for (const l of x.labels) labels.push([id, B(l)]);
    for (const u of new Set([creatorId, assignee].filter(Boolean))) watchers.push([id, u]);
    for (const c of x.components) comps.push([id, cid(c)]);
  });
  stmts.push(
    // starter issues are not announced (no Slack, webhook or email), as intended
    ...insertLiteralRows(
      'issues',
      [
        'id',
        'project_id',
        'number',
        'key',
        'type',
        'title',
        'description',
        'status_id',
        'priority',
        'assignee_id',
        'reporter_id',
        'parent_id',
        'sprint_id',
        'story_points',
        'due_date',
        'start_date',
        'rank',
        'created_at',
        'updated_at',
        'resolved_at',
      ],
      issueRows,
    ),
    ...insertLiteralRows('issue_history', ['id', 'issue_id', 'actor_id', 'field', 'old_value', 'new_value', 'created_at'], history),
    ...insertLiteralRows('issue_labels', ['issue_id', 'label'], labels),
    ...insertLiteralRows('watchers', ['issue_id', 'user_id'], watchers),
    ...insertLiteralRows('issue_components', ['issue_id', 'component_id'], comps),
  );

  const project = { workflow, issue_seq: body.issues.length };
  for (const [k, v] of Object.entries(body.permissions)) project[PROJECT_PERMS[k].col] = v;
  return { statuses, project, stmts, summary: bodySummary(body) };
}

// ---------- saving a project as a template ----------

/**
 * A template body from an existing project: statuses, workflow, fields, components, issue templates, recurring rules,
 * permissions and labels in use. includeIssues: its open epics, stories and tasks as starter issues (due dates become
 * 'day N' counted from the day the project was created). keepRoles: people who are the project lead become the role
 * 'lead' (assignees, component leads, recurring and workflow assignees); everyone else is dropped. Never comments,
 * history, members or user ids.
 */
export async function projectToBody(db, project, { includeIssues = false, keepRoles = false } = {}) {
  const pid = project.id;
  const [statusRows, fields, compRows, tplRows, recRows, labelRows] = await Promise.all([
    db.all('SELECT * FROM statuses WHERE project_id = ? ORDER BY position', [pid]),
    listFields(db, pid, { activeOnly: true }),
    db.all('SELECT * FROM components WHERE project_id = ? ORDER BY LOWER(name)', [pid]),
    db.all('SELECT * FROM issue_templates WHERE project_id = ? ORDER BY position, LOWER(name)', [pid]),
    db.all('SELECT * FROM recurring_rules WHERE project_id = ? ORDER BY created_at', [pid]),
    db.all(
      `SELECT l.label, CAST(COUNT(*) AS INTEGER) AS n FROM issue_labels l JOIN issues i ON i.id = l.issue_id
             WHERE i.project_id = ? AND i.deleted_at IS NULL GROUP BY l.label ORDER BY n DESC, l.label LIMIT ${LIMITS.labels}`,
      [pid],
    ),
  ]);
  const asRole = (userId) => (keepRoles && userId && userId === project.lead_id ? 'lead' : null);

  // unique status names (a project may have two columns with the same name)
  const names = new Map();
  const used = new Set();
  for (const s of statusRows.slice(0, LIMITS.statuses)) {
    let n = s.name;
    for (let k = 2; used.has(n.toLowerCase()); k++) n = `${s.name} (${k})`;
    used.add(n.toLowerCase());
    names.set(s.id, n);
  }
  const statuses = statusRows
    .filter((s) => names.has(s.id))
    .map((s) => ({ name: names.get(s.id), category: s.category, wipLimit: s.wip_limit ?? null }));
  if (!statuses.some((s) => s.category === 'done') && statuses.length) statuses[statuses.length - 1].category = 'done';

  const fieldById = new Map(fields.map((f) => [f.id, f]));
  const valueNames = (f, v) => {
    if (!f || f.type === 'user') return null;
    const name = (id) => f.options.find((o) => o.id === id || o.name === id)?.name;
    if (f.type === 'select') return name(v) ?? null;
    if (f.type === 'multiselect') return (Array.isArray(v) ? v : []).map(name).filter(Boolean);
    return v;
  };

  // workflow
  let workflow = null;
  const wf = parseWorkflow(project.workflow);
  if (wf.transitions || Object.keys(wf.statuses).length || !wf.adminBypass) {
    workflow = { transitions: null, adminBypass: wf.adminBypass, statuses: {} };
    if (wf.transitions) {
      workflow.transitions = {};
      for (const [from, to] of Object.entries(wf.transitions))
        if (names.has(from)) workflow.transitions[names.get(from)] = (to || []).filter((x) => names.has(x)).map((x) => names.get(x));
    }
    for (const [id, rule] of Object.entries(wf.statuses)) {
      if (!names.has(id) || !isObj(rule)) continue;
      const required = (rule.required || [])
        .map((k) => (k.startsWith('cf:') ? (fieldById.get(k.slice(3)) ? `field:${fieldById.get(k.slice(3)).name}` : null) : k))
        .filter(Boolean);
      const a = rule.actions || {};
      const actions = {};
      if (a.assignee) {
        if (a.assignee.to === 'user') {
          const r = asRole(a.assignee.userId);
          if (r) actions.assignee = { to: 'role', role: r };
        } else actions.assignee = { to: a.assignee.to };
      }
      for (const k of ['addLabels', 'removeLabels', 'comment', 'sprint', 'notify']) if (a[k]) actions[k] = a[k];
      if (a.field) {
        const f = fieldById.get(a.field.fieldId);
        const v = valueNames(f, a.field.value);
        if (f && v !== null && !(Array.isArray(v) && !v.length)) actions.field = { field: f.name, value: v };
      }
      workflow.statuses[names.get(id)] = { required, actions };
    }
  }

  const compName = new Map(compRows.map((c) => [c.id, c.name]));
  const tplName = new Map(tplRows.map((x) => [x.id, x.name]));
  const body = {
    statuses,
    workflow,
    fields: fields
      .map((f) => ({
        name: f.name,
        type: f.type,
        options: f.options.filter((o) => !o.archived).map((o) => o.name),
        required: f.required,
        help: f.help || null,
        issueTypes: f.issueTypes,
      }))
      .filter((f) => !OPTION_TYPES.includes(f.type) || f.options.length),
    components: compRows.slice(0, LIMITS.components).map((c) => ({
      name: c.name,
      description: c.description || null,
      lead: asRole(c.lead_id),
      defaultAssignee: asRole(c.default_assignee_id),
    })),
    issueTemplates: tplRows.slice(0, LIMITS.issueTemplates).map((x) => {
      const values = {};
      for (const [fid, v] of Object.entries(parseObject(x.fields))) {
        const f = fieldById.get(fid);
        const vv = valueNames(f, v);
        if (f && vv !== null && !(Array.isArray(vv) && !vv.length)) values[f.name] = vv;
      }
      return {
        name: x.name,
        type: x.type,
        titlePrefix: x.title_prefix || null,
        description: x.description || null,
        priority: x.priority || null,
        labels: parseList(x.labels),
        subtasks: parseList(x.subtasks),
        fields: values,
        components: parseList(x.components)
          .map((id) => compName.get(id))
          .filter(Boolean),
      };
    }),
    recurring: recRows.slice(0, LIMITS.recurring).map((r) => ({
      name: r.name,
      title: r.title,
      type: r.type === 'subtask' ? 'task' : r.type,
      description: r.description || null,
      priority: r.priority,
      labels: parseList(r.labels),
      subtasks: parseList(r.subtasks),
      template: r.template_id ? tplName.get(r.template_id) || null : null,
      sprint: r.sprint,
      dueDays: r.due_days ?? null,
      schedule: parseObject(r.schedule),
      start: null,
      assignee: asRole(r.assignee_id),
    })),
    permissions: Object.fromEntries(
      Object.entries(PROJECT_PERMS).map(([k, d]) => [k, d.values.includes(project[d.col]) ? project[d.col] : d.values[0]]),
    ),
    labels: labelRows.map((r) => r.label),
    sprint: null,
    issues: [],
  };

  if (includeIssues) {
    const rows = await db.all(
      `SELECT i.id, i.type, i.title, i.description, i.priority, i.parent_id, i.due_date, i.start_date, i.story_points, i.assignee_id FROM issues i
         JOIN statuses s ON s.id = i.status_id
        WHERE i.project_id = ? AND i.deleted_at IS NULL AND s.category <> 'done' AND i.type IN ('epic', 'story', 'task')
        ORDER BY CASE WHEN i.type = 'epic' THEN 0 ELSE 1 END, i.rank LIMIT ${LIMITS.issues}`,
      [pid],
    );
    const ids = rows.map((r) => r.id);
    const lbl = new Map();
    const cmp = new Map();
    for (const part of chunks(ids)) {
      const ph = placeholders(part.length);
      const [ls, cs] = await Promise.all([
        db.all(`SELECT issue_id, label FROM issue_labels WHERE issue_id IN (${ph})`, part),
        db.all(`SELECT issue_id, component_id FROM issue_components WHERE issue_id IN (${ph})`, part),
      ]);
      for (const r of ls) (lbl.get(r.issue_id) || lbl.set(r.issue_id, []).get(r.issue_id)).push(r.label);
      for (const r of cs)
        if (compName.has(r.component_id))
          (cmp.get(r.issue_id) || cmp.set(r.issue_id, []).get(r.issue_id)).push(compName.get(r.component_id));
    }
    const base = String(project.created_at).slice(0, 10);
    const relDay = (d) =>
      d
        ? `day ${Math.min(730, Math.max(1, Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${base}T00:00:00Z`)) / 864e5) + 1))}`
        : null;
    const kept = new Set(ids);
    body.issues = rows.map((r, i) => ({
      ref: `i${i + 1}`,
      type: r.type,
      title: r.title,
      description: r.description || null,
      priority: r.priority,
      labels: (lbl.get(r.id) || []).slice(0, 20),
      parent: r.parent_id && kept.has(r.parent_id) ? `i${ids.indexOf(r.parent_id) + 1}` : null,
      due: relDay(r.due_date),
      start: relDay(r.start_date),
      storyPoints: r.story_points ?? null,
      assignee: asRole(r.assignee_id),
      components: cmp.get(r.id) || [],
      sprint: false,
    }));
  }
  return readBody(body); // same checks as any other template
}
