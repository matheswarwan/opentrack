import { body, fail, str, num, isoDate, EMAIL_RE } from '../lib/http.js';
import { uuid, now } from '../lib/crypto.js';
import { historyStmt, changeSource } from '../lib/history.js';
import { noticeStmts } from '../lib/notifications.js';
import { projectAccess } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import { TYPES, PRIORITIES, cleanLabels, parentTypeError } from '../lib/issues/model.js';
import { allocate, issueInsertStatements } from '../lib/issues/create.js';
import { listFields, loadPeople, readFieldValues, fieldValueStmts } from '../lib/customFields.js';
import { resolveIds, releaseInsertStmts, defaultAssignee } from '../lib/releases.js';
import { placeholders, chunks } from '../db/sql.js';

export const MAX_IMPORT_ROWS = 500;
const ISSUES_PER_BATCH = 50;

/** First non-empty value among `names` in a row (CSV cells come as strings). */
function pick(row, ...names) {
  for (const n of names) {
    const v = row[n];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && !v.trim()) continue;
    return typeof v === 'string' ? v.trim() : v;
  }
  return undefined;
}

function normType(v) {
  const t = String(v)
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  return t === 'subtask' ? 'subtask' : t;
}

/** Find a user by email, or by name when exactly one active user has it. */
function findUser(people, value) {
  const v = String(value).trim().toLowerCase();
  if (EMAIL_RE.test(v)) return people.byEmail.get(v) || null;
  const named = people.byName.get(v) || [];
  return named.length === 1 ? named[0] : null;
}

/**
 * Validate every row. Returns { rows: [{ row, title, errors, clean }] }; `clean` holds
 * the values to write (parent as { id } or { row }).
 */
async function validate(db, project, user, rows, canAdmin = false) {
  const [statuses, sprints, users] = await Promise.all([
    db.all('SELECT id, name, category, position FROM statuses WHERE project_id = ? ORDER BY position', [project.id]),
    db.all(`SELECT id, name FROM sprints WHERE project_id = ? AND state <> 'closed'`, [project.id]),
    // people who can be named: everyone but guests who are not members of this project
    db.all(
      `SELECT u.id, u.email, u.name FROM users u WHERE u.status <> 'deactivated'
              AND (u.role <> 'guest' OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = ? AND m.user_id = u.id))`,
      [project.id],
    ),
  ]);
  // custom fields: rows may carry fields: { <field id or name>: value } (CSV text: "a, b" for multi-select, yes/no, names)
  const fields = await listFields(db, project.id);
  const fieldPeople = fields.some((f) => f.type === 'user' && !f.archived) ? await loadPeople(db, [], { all: true }) : {};
  const people = { byEmail: new Map(), byName: new Map() };
  for (const u of users) {
    people.byEmail.set(u.email.toLowerCase(), u);
    const n = u.name.toLowerCase();
    people.byName.set(n, [...(people.byName.get(n) || []), u]);
  }
  // Parents named by key: load them in one go.
  const parentKeys = [
    ...new Set(
      rows
        .map((r) => (r && typeof r === 'object' ? pick(r, 'parent', 'parentKey') : undefined))
        .filter((p) => p !== undefined && !String(p).startsWith('#'))
        .map((p) => String(p).toUpperCase()),
    ),
  ];
  const parents = new Map();
  for (const keys of chunks(parentKeys, 100)) {
    for (const p of await db.all(
      `SELECT id, key, type, project_id FROM issues WHERE deleted_at IS NULL AND key IN (${placeholders(keys.length)})`,
      keys,
    ))
      parents.set(p.key, p);
  }

  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const errors = [];
    const check = (fn) => {
      try {
        return fn();
      } catch (e) {
        errors.push(e.message);
        return undefined;
      }
    };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      out.push({ row: i + 1, title: '', errors: ['Row must be an object'], clean: null });
      continue;
    }
    const text = (v) => (v === undefined ? undefined : String(v));
    const clean = {};
    clean.title = check(() => str(text(pick(raw, 'title', 'summary')), { required: true, max: 255, name: 'Title' }));
    clean.description = check(() => str(text(pick(raw, 'description')), { max: 50000, name: 'Description' })) || null;

    const type = pick(raw, 'type');
    clean.type = type === undefined ? 'task' : normType(type);
    if (!TYPES.includes(clean.type)) errors.push(`Type must be one of: ${TYPES.join(', ')}`);

    const priority = pick(raw, 'priority');
    clean.priority = priority === undefined ? 'medium' : String(priority).toLowerCase();
    if (!PRIORITIES.includes(clean.priority)) errors.push(`Priority must be one of: ${PRIORITIES.join(', ')}`);

    const assignee = pick(raw, 'assignee');
    clean.assigneeId = null;
    if (assignee !== undefined) {
      const u = findUser(people, assignee);
      if (u) clean.assigneeId = u.id;
      else errors.push(`Assignee not found: ${assignee}`);
    }
    const reporter = pick(raw, 'reporter');
    clean.reporterId = user.id;
    if (reporter !== undefined) {
      const u = findUser(people, reporter);
      if (u) clean.reporterId = u.id;
      else errors.push(`Reporter not found: ${reporter}`);
    }

    const labels = pick(raw, 'labels');
    clean.labels =
      labels === undefined ? [] : check(() => cleanLabels(Array.isArray(labels) ? labels : String(labels).split(/[\s,]+/))) || [];

    const status = pick(raw, 'status');
    const st = status === undefined ? statuses[0] : statuses.find((s) => s.name.toLowerCase() === String(status).toLowerCase());
    if (!st) errors.push(`Status not found: ${status}`);
    clean.statusId = st?.id;
    clean.done = st?.category === 'done';

    const sprint = pick(raw, 'sprint');
    clean.sprintId = null;
    if (sprint !== undefined) {
      const sp = sprints.find((s) => s.name.toLowerCase() === String(sprint).toLowerCase());
      if (sp) clean.sprintId = sp.id;
      else errors.push(`Sprint not found or closed: ${sprint}`);
    }

    clean.storyPoints = check(() => num(pick(raw, 'story_points', 'storyPoints') ?? null, { name: 'Story points', min: 0, max: 1000 }));
    clean.estimateHours = check(() => num(pick(raw, 'estimate_hours', 'estimateHours') ?? null, { name: 'Estimate', min: 0, max: 10000 }));
    clean.dueDate = check(() => isoDate(text(pick(raw, 'due_date', 'dueDate')) ?? null, 'Due date'));
    clean.storyPoints ??= null;
    clean.estimateHours ??= null;
    clean.dueDate ??= null;

    const parent = pick(raw, 'parent', 'parentKey');
    clean.parent = null;
    if (parent === undefined) {
      if (clean.type === 'subtask') errors.push('A sub-task needs a parent issue');
    } else if (/^#\d+$/.test(String(parent))) {
      const n = Number(String(parent).slice(1));
      if (n < 1 || n > i) errors.push(`Parent ${parent} must be an earlier row of this import`);
      else {
        const ref = out[n - 1];
        const err = ref.clean && parentTypeError(clean.type, ref.clean.type);
        if (!ref.clean) errors.push(`Parent ${parent} is not a valid row`);
        else if (err) errors.push(err);
        else clean.parent = { row: n };
      }
    } else {
      const p = parents.get(String(parent).toUpperCase());
      if (!p || p.project_id !== project.id) errors.push(`Parent not found in this project: ${parent}`);
      else {
        const err = parentTypeError(clean.type, p.type);
        if (err) errors.push(err);
        else clean.parent = { id: p.id };
      }
    }
    clean.fieldValues = new Map();
    try {
      clean.fieldValues = await readFieldValues(db, project.id, raw.fields, {
        type: TYPES.includes(clean.type) ? clean.type : 'task',
        create: true,
        lenient: true,
        fields,
        people: fieldPeople,
      });
    } catch (e) {
      errors.push(e.message);
    }
    // components and fix versions by name (Jira's Component/s and Fix Version/s): a list or "a, b". Names the project
    // does not have yet are created for project admins; for others they are errors.
    for (const [kind, names, label] of [
      ['components', ['components', 'component'], 'Component'],
      ['fixVersions', ['fix_versions', 'fixVersions', 'fix_version'], 'Fix version'],
    ]) {
      clean[kind] = [];
      clean[`new_${kind}`] = [];
      const v = pick(raw, ...names);
      if (v === undefined) continue;
      try {
        const missing = [];
        const list = Array.isArray(v) ? v.map(String) : String(v).split(',');
        const found = await resolveIds(db, project.id, kind, list.map((x) => x.trim()).filter(Boolean), { missing });
        clean[kind] = found.map((r) => r.id);
        if (kind === 'components' && !clean.assigneeId) {
          clean.byComponent = await defaultAssignee(db, found); // a component's default assignee takes an unassigned issue
          if (clean.byComponent) clean.assigneeId = clean.byComponent.id;
        }
        for (const m of missing) {
          if (!canAdmin) errors.push(`${label} not found: ${m}. A project admin can add it, or import as a project admin to create it.`);
          else if (m.length > 80) errors.push(`${label} name is too long: ${m.slice(0, 40)}...`);
          else clean[`new_${kind}`].push(m);
        }
      } catch (e) {
        errors.push(e.message);
      }
    }
    out.push({ row: i + 1, title: clean.title || '', errors, clean });
  }
  return out;
}

export function registerImport(app) {
  // Bulk create issues: { rows: [{ title, type, description, priority, assignee, reporter, labels, parent,
  // status, sprint, story_points, due_date, estimate_hours }], dryRun }. Every row is checked first;
  // nothing is written unless every row is valid.
  app.post('/api/projects/:key/import', async (c) => {
    if (Number(c.req.header('content-length') || 0) > 8_000_000) fail(413, 'The import is too large');
    const access = await projectAccess(c, c.req.param('key'), 'edit'); // never guests (they cannot edit every issue)
    const { project, canAdmin } = access;
    if (!access.canCreate) fail(403, 'Only project admins can create issues in this project');
    const b = await body(c);
    if (!Array.isArray(b.rows) || !b.rows.length) fail(400, 'rows must be a non-empty list');
    if (b.rows.length > MAX_IMPORT_ROWS) fail(400, `At most ${MAX_IMPORT_ROWS} rows at a time`);
    const db = c.env.db;
    const user = c.get('user');
    const checked = await validate(db, project, user, b.rows, canAdmin);
    if (!access.canSprints && checked.some((r) => r.clean.sprintId)) fail(403, 'Only project admins can manage sprints in this project');
    const report = checked.map((r) => ({ row: r.row, title: r.title, errors: r.errors }));
    const invalid = report.filter((r) => r.errors.length).length;
    if (b.dryRun) return c.json({ dryRun: true, valid: invalid === 0, invalidRows: invalid, rows: report });
    if (invalid) fail(400, `${invalid} of ${report.length} rows have errors. Nothing was imported.`, { rows: report });

    const n = checked.length;
    const slot = await allocate(db, project, n);
    const ids = checked.map(() => uuid());
    const t = now();
    const created = [];
    let stmts = [];
    // components and releases named in the file that the project does not have yet (project admins only)
    const made = { components: new Map(), fixVersions: new Map() };
    for (const kind of ['components', 'fixVersions']) {
      for (const r of checked) {
        for (const name of r.clean[`new_${kind}`]) {
          if (made[kind].has(name.toLowerCase())) continue;
          const nid = uuid();
          made[kind].set(name.toLowerCase(), nid);
          stmts.push(
            kind === 'components'
              ? {
                  sql: 'INSERT INTO components (id, project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
                  params: [nid, project.id, name, t, t],
                }
              : {
                  sql: `INSERT INTO releases (id, project_id, name, status, created_at, updated_at) VALUES (?, ?, ?, 'unreleased', ?, ?)`,
                  params: [nid, project.id, name, t, t],
                },
          );
        }
      }
    }
    for (let i = 0; i < n; i++) {
      const { clean } = checked[i];
      const number = slot.number(i);
      const one = issueInsertStatements({
        ...clean,
        id: ids[i],
        project,
        number,
        rank: slot.rank(i),
        actor: user,
        t,
        parentId: clean.parent ? clean.parent.id || ids[clean.parent.row - 1] : null,
      });
      stmts.push(...one.stmts, ...noticeStmts(one.notices)); // in-app notices only: an import is not announced (no Slack, webhook or email), as intended
      stmts.push(...fieldValueStmts(ids[i], clean.fieldValues));
      const named = (kind) => [...new Set([...clean[kind], ...clean[`new_${kind}`].map((x) => made[kind].get(x.toLowerCase()))])];
      stmts.push(...releaseInsertStmts(ids[i], named('components'), named('fixVersions')));
      if (clean.byComponent) {
        stmts.push(historyStmt(ids[i], user.id, 'assignee', null, clean.byComponent.name, t, changeSource(c)));
      }
      created.push({ row: i + 1, key: `${project.key}-${number}` });
      if ((i + 1) % ISSUES_PER_BATCH === 0 || i === n - 1) {
        if (i === n - 1)
          stmts.push(
            audit(user.id, 'issues.imported', 'project', project.id, {
              count: n,
              from: created[0].key,
              to: created[n - 1].key,
              ...(made.components.size || made.fixVersions.size
                ? { newComponents: made.components.size, newReleases: made.fixVersions.size }
                : {}),
            }),
          );
        await db.batch(stmts);
        stmts = [];
      }
    }
    return c.json({ dryRun: false, created }, 201);
  });
}
