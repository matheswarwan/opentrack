// Custom fields per project: definitions (table custom_fields), values (issue_field_values), and the helpers the
// issue routes, search, exports, reports and imports use. Values are stored as normalized text so that filtering
// stays portable (SQLite/D1 and Postgres, no JSON functions):
//   text, longtext, url: the text        number: plain decimal string ("12.5")    date: YYYY-MM-DD
//   checkbox: '1' or '0'                 select: an option id                     user: a user id
//   multiselect: JSON list of option ids, in the field's option order
// No row means empty. The API takes and returns values in "API form": strings, numbers, booleans, option ids (or
// option names), lists of option ids, user ids (or emails). Payloads show display-ready values (see displayValue).
import { fail } from './http.js';
import { validDate } from './time.js';
import { TYPES as ISSUE_TYPES } from './issues/model.js';
import { avatarUrl } from './avatars.js';
import { placeholders, chunks } from '../db/sql.js';
import { parseJson } from './json.js';

export const FIELD_TYPES = ['text', 'longtext', 'number', 'select', 'multiselect', 'date', 'checkbox', 'user', 'url'];
export const OPTION_TYPES = ['select', 'multiselect'];
// Custom report group-by works on these (a few values each).
export const GROUPABLE_TYPES = ['select', 'multiselect', 'user', 'checkbox'];
export const MAX_FIELDS = 50;
export const MAX_OPTIONS = 100;
const MAX_MULTI = 50;
const MAX_FILTERS = 10;
export const FIELD_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
export const CF_QUERY_RE = /^cf\.([A-Za-z0-9-]{1,64})(\.empty)?$/;

export function fieldOut(r) {
  const options = parseJson(r.options, []);
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    type: r.type,
    options: Array.isArray(options) ? options.map((o) => ({ id: o.id, name: o.name, archived: Boolean(o.archived) })) : [],
    required: Boolean(r.required),
    help: r.help || '',
    issueTypes: parseJson(r.issue_types, []),
    position: r.position,
    archived: Boolean(r.archived),
  };
}

/** A project's fields in display order (archived ones too, unless activeOnly). */
export async function listFields(db, projectId, { activeOnly = false } = {}) {
  const rows = await db.all(
    `SELECT * FROM custom_fields WHERE project_id = ?${activeOnly ? ' AND archived = 0' : ''} ORDER BY position, created_at`,
    [projectId],
  );
  return rows.map(fieldOut);
}

/** Active fields of several projects: Map projectId -> [field]. */
export async function fieldsOfProjects(db, projectIds) {
  const out = new Map();
  for (const part of chunks([...new Set(projectIds)])) {
    const rows = await db.all(
      `SELECT * FROM custom_fields WHERE archived = 0 AND project_id IN (${placeholders(part.length)}) ORDER BY position, created_at`,
      part,
    );
    for (const r of rows) {
      if (!out.has(r.project_id)) out.set(r.project_id, []);
      out.get(r.project_id).push(fieldOut(r));
    }
  }
  return out;
}

export const appliesTo = (field, type) => !field.issueTypes.length || field.issueTypes.includes(type);

// ---------- values ----------

function normNumber(v) {
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (typeof v === 'string' && !String(v).trim()) return null;
  if (!Number.isFinite(n) || Math.abs(n) > 1e12) return undefined;
  const s = String(Math.round(n * 1e6) / 1e6);
  return /e/i.test(s) ? '0' : s;
}
function normBool(v) {
  if (v === true || v === 1) return '1';
  if (v === false || v === 0) return '0';
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on', 'x'].includes(s)) return '1';
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return '0';
  return undefined;
}
function findOption(field, v) {
  const s = String(v).trim();
  return field.options.find((o) => o.id === s) || field.options.find((o) => o.name.toLowerCase() === s.toLowerCase()) || null;
}

/**
 * Normalize one value for storage. Returns the text to store, or null to clear the value.
 * opts.current: the stored text now (an archived option already set may stay set).
 * opts.lenient: CSV import (multi-select as "a, b", user by name).
 * opts.people: { byId, byEmail, byName } for user fields (see loadPeople).
 */
export function normalizeValue(field, v, opts = {}) {
  const name = field.name;
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' && !v.trim() && field.type !== 'longtext') return null;
  switch (field.type) {
    case 'text':
    case 'longtext': {
      if (typeof v !== 'string' && typeof v !== 'number') fail(400, `${name} must be text`);
      const t = field.type === 'text' ? String(v).trim() : String(v).replace(/\s+$/, '');
      if (!t.trim()) return null;
      const max = field.type === 'text' ? 500 : 10000;
      if (t.length > max) fail(400, `${name} is too long (max ${max} characters)`);
      return t;
    }
    case 'url': {
      const t = String(v).trim();
      let ok = false;
      try {
        ok = ['http:', 'https:'].includes(new URL(t).protocol);
      } catch {
        /* not a URL */
      }
      if (!ok || t.length > 2000) fail(400, `${name} must be a web address starting with http:// or https://`);
      return t;
    }
    case 'number': {
      if (typeof v !== 'number' && typeof v !== 'string') fail(400, `${name} must be a number`);
      const s = normNumber(v);
      if (s === undefined) fail(400, `${name} must be a number`);
      return s;
    }
    case 'date': {
      const s = String(v).trim();
      if (!validDate(s)) fail(400, `${name} must be a date as YYYY-MM-DD`);
      return s;
    }
    case 'checkbox': {
      const s = normBool(v);
      if (s === undefined) fail(400, `${name} must be true or false`);
      return s;
    }
    case 'select': {
      if (typeof v !== 'string' && typeof v !== 'number') fail(400, `${name} must be one option`);
      const o = findOption(field, v);
      if (!o) fail(400, `${name}: no option "${v}"`);
      if (o.archived && o.id !== opts.current) fail(400, `${name}: the option "${o.name}" is archived`);
      return o.id;
    }
    case 'multiselect': {
      let list = v;
      if (typeof v === 'string')
        list = opts.lenient
          ? v
              .split(/[,;]/)
              .map((x) => x.trim())
              .filter(Boolean)
          : [v];
      if (!Array.isArray(list)) fail(400, `${name} must be a list of options`);
      if (list.length > MAX_MULTI) fail(400, `${name}: at most ${MAX_MULTI} options`);
      const before = new Set(opts.current ? parseJson(opts.current, []) : []);
      const ids = new Set();
      for (const x of list) {
        if (typeof x !== 'string' && typeof x !== 'number') fail(400, `${name} must be a list of options`);
        const o = findOption(field, x);
        if (!o) fail(400, `${name}: no option "${x}"`);
        if (o.archived && !before.has(o.id)) fail(400, `${name}: the option "${o.name}" is archived`);
        ids.add(o.id);
      }
      if (!ids.size) return null;
      return JSON.stringify(field.options.filter((o) => ids.has(o.id)).map((o) => o.id));
    }
    case 'user': {
      if (typeof v !== 'string') fail(400, `${name} must be a person`);
      const s = v.trim();
      const p = opts.people || {};
      const u = p.byId?.get(s) || p.byEmail?.get(s.toLowerCase()) || (opts.lenient ? onlyOne(p.byName?.get(s.toLowerCase())) : null);
      if (!u) fail(400, `${name}: person not found: ${s}`);
      if (u.status === 'deactivated' && u.id !== opts.current) fail(400, `${name}: ${u.name} is deactivated`);
      return u.id;
    }
    default:
      fail(400, `${name} has an unknown type`);
  }
  return null;
}
const onlyOne = (list) => (list && list.length === 1 ? list[0] : null);

/** People lookups for user fields: every user named by id or email in `values` (or all, for lenient imports). */
export async function loadPeople(db, values, { all = false } = {}) {
  const byId = new Map();
  const byEmail = new Map();
  const byName = new Map();
  const add = (u) => {
    byId.set(u.id, u);
    byEmail.set(u.email.toLowerCase(), u);
    const n = u.name.toLowerCase();
    byName.set(
      n,
      [...(byName.get(n) || []), u].filter((x) => x.status !== 'deactivated'),
    );
  };
  if (all) {
    for (const u of await db.all('SELECT id, email, name, status FROM users')) add(u);
  } else {
    const keys = [...new Set(values.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim()))];
    for (const part of chunks(keys, 45)) {
      const rows = await db.all(
        `SELECT id, email, name, status FROM users WHERE id IN (${placeholders(part.length)}) OR LOWER(email) IN (${placeholders(part.length)})`,
        [...part, ...part.map((x) => x.toLowerCase())],
      );
      rows.forEach(add);
    }
  }
  return { byId, byEmail, byName };
}

/** Find a field by id or name (case-insensitive) among `fields`. */
export function findField(fields, key) {
  const k = String(key).trim();
  return fields.find((f) => f.id === k) || fields.find((f) => f.name.toLowerCase() === k.toLowerCase()) || null;
}

/**
 * Read `fields` from an issue create or update body. Returns Map fieldId -> text | null (null clears).
 * opts: type (issue type), current (Map fieldId -> stored text), create (enforce required), lenient (import).
 * Keys may be field ids or names. Fields that do not apply to the type, archived fields and unknown names fail.
 */
export async function readFieldValues(db, projectId, input, opts = {}) {
  const fields = opts.fields || (await listFields(db, projectId));
  const out = new Map();
  if (input !== undefined && input !== null) {
    if (typeof input !== 'object' || Array.isArray(input)) fail(400, 'fields must be an object of field id: value');
    const entries = Object.entries(input);
    const users = entries.filter(([k]) => findField(fields, k)?.type === 'user').map(([, v]) => v);
    const people = opts.people || (users.length ? await loadPeople(db, users) : {});
    for (const [k, v] of entries) {
      const f = findField(fields, k);
      if (!f) fail(400, `Unknown field: ${k}`);
      if (f.archived) fail(400, `${f.name} is archived`);
      if (opts.type && !appliesTo(f, opts.type) && v !== null && v !== '')
        fail(400, `${f.name} does not apply to ${opts.type === 'subtask' ? 'sub-task' : opts.type}s`);
      out.set(f.id, normalizeValue(f, v, { current: opts.current?.get(f.id), lenient: opts.lenient, people }));
    }
  }
  if (opts.create) {
    for (const f of fields) {
      if (f.archived || !f.required || (opts.type && !appliesTo(f, opts.type))) continue;
      if (out.get(f.id) === null || out.get(f.id) === undefined) fail(400, `${f.name} is required`);
    }
  }
  return out;
}

const UPSERT =
  'INSERT INTO issue_field_values (issue_id, field_id, value) VALUES (?, ?, ?) ON CONFLICT (issue_id, field_id) DO UPDATE SET value = excluded.value';

/** Statements that write values (Map fieldId -> text | null) for one issue. */
export function fieldValueStmts(issueId, values) {
  const stmts = [];
  for (const [fid, v] of values) {
    if (v === null || v === undefined)
      stmts.push({ sql: 'DELETE FROM issue_field_values WHERE issue_id = ? AND field_id = ?', params: [issueId, fid] });
    else stmts.push({ sql: UPSERT, params: [issueId, fid, v] });
  }
  return stmts;
}

/** Stored values of one issue: Map fieldId -> text. */
export async function issueValues(db, issueId) {
  const rows = await db.all('SELECT field_id, value FROM issue_field_values WHERE issue_id = ?', [issueId]);
  return new Map(rows.map((r) => [r.field_id, r.value]));
}

/**
 * Changes to an issue's fields from a PATCH body: { stmts, history: [['field:<name>', old, new]] } with display text.
 * A required field cannot be cleared.
 */
export async function fieldChangeSet(db, issue, input, type) {
  if (input === undefined) return { stmts: [], history: [], values: new Map() };
  const fields = await listFields(db, issue.project_id);
  const current = await issueValues(db, issue.id);
  const next = await readFieldValues(db, issue.project_id, input, { type, current, fields });
  const changed = new Map();
  for (const [fid, v] of next) {
    if ((current.get(fid) ?? null) === v) continue;
    const f = fields.find((x) => x.id === fid);
    if (v === null && f.required && appliesTo(f, type)) fail(400, `${f.name} is required`);
    changed.set(fid, v);
  }
  if (!changed.size) return { stmts: [], history: [], values: changed };
  const userIds = [];
  for (const [fid, v] of changed) {
    if (fields.find((x) => x.id === fid).type === 'user') userIds.push(v, current.get(fid));
  }
  const people = userIds.filter(Boolean).length ? await peopleById(db, userIds.filter(Boolean)) : new Map();
  const history = [];
  for (const [fid, v] of changed) {
    const f = fields.find((x) => x.id === fid);
    history.push([`field:${f.name}`.slice(0, 100), displayText(f, current.get(fid) ?? null, people), displayText(f, v, people)]);
  }
  return { stmts: fieldValueStmts(issue.id, changed), history, values: changed }; // values: what this change sets (workflow checks)
}

async function peopleById(db, ids) {
  const out = new Map();
  for (const part of chunks([...new Set(ids)])) {
    for (const u of await db.all(
      `SELECT id, name, avatar_color, avatar_version, status FROM users WHERE id IN (${placeholders(part.length)})`,
      part,
    ))
      out.set(u.id, u);
  }
  return out;
}

/** The value as shown in payloads: text, number, boolean, {id, name} options, a person. null when empty. */
export function displayValue(field, text, people = new Map()) {
  if (text === null || text === undefined) return null;
  switch (field.type) {
    case 'number':
      return Number(text);
    case 'checkbox':
      return text === '1';
    case 'select': {
      const o = field.options.find((x) => x.id === text);
      return o ? { id: o.id, name: o.name, ...(o.archived ? { archived: true } : {}) } : null;
    }
    case 'multiselect': {
      const ids = new Set(parseJson(text, []));
      return field.options.filter((o) => ids.has(o.id)).map((o) => ({ id: o.id, name: o.name, ...(o.archived ? { archived: true } : {}) }));
    }
    case 'user': {
      const u = people.get(text);
      return u
        ? { id: u.id, name: u.name, avatarColor: u.avatar_color, avatarUrl: avatarUrl(u.id, u.avatar_version) }
        : { id: text, name: 'Former user' };
    }
    default:
      return text;
  }
}

/** The value as plain text (history, CSV, feeds). */
export function displayText(field, text, people = new Map()) {
  const v = displayValue(field, text, people);
  if (v === null || v === undefined) return null;
  if (field.type === 'checkbox') return v ? 'Yes' : 'No';
  if (field.type === 'select' || field.type === 'user') return v.name;
  if (field.type === 'multiselect') return v.map((o) => o.name).join(', ') || null;
  return String(v);
}

/**
 * Attach `fields` (fieldId -> display value, active fields only) to issue payloads; values in batches of 80.
 * opts.text: plain text values instead (exports). Returns { issues, fields: Map projectId -> [field] }.
 */
export async function withFields(db, issues, opts = {}) {
  if (!issues.length) return { issues, fields: new Map() };
  const values = new Map(); // issueId -> [{ field_id, value }]
  for (const part of chunks(issues.map((i) => i.id))) {
    const rows = await db.all(
      `SELECT issue_id, field_id, value FROM issue_field_values WHERE issue_id IN (${placeholders(part.length)})`,
      part,
    );
    for (const r of rows) {
      if (!values.has(r.issue_id)) values.set(r.issue_id, []);
      values.get(r.issue_id).push(r);
    }
  }
  const fields = await fieldsOfProjects(
    db,
    issues.map((i) => i.projectId),
  );
  const byId = new Map([...fields.values()].flat().map((f) => [f.id, f]));
  const userIds = [];
  for (const list of values.values()) for (const r of list) if (byId.get(r.field_id)?.type === 'user') userIds.push(r.value);
  const people = userIds.length ? await peopleById(db, userIds) : new Map();
  for (const i of issues) {
    const out = {};
    for (const r of values.get(i.id) || []) {
      const f = byId.get(r.field_id);
      if (!f) continue; // archived field
      out[f.id] = opts.text ? displayText(f, r.value, people) : displayValue(f, r.value, people);
    }
    i.fields = out;
  }
  return { issues, fields };
}

// ---------- search ----------

const likeEscape = (s) => s.replace(/[%_\\]/g, (m) => `\\${m}`);
function exactParam(v) {
  const s = String(v).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return normNumber(s) ?? s;
  const b = ['true', 'yes', 'false', 'no'].includes(s.toLowerCase()) ? normBool(s) : undefined;
  return b ?? s;
}

/**
 * Conditions on custom fields from search parameters (alias i = issues):
 *   cf.<fieldId>=<value>   text fields: contains (case-insensitive); multi-select: has that option id;
 *                          select, user, number, date, checkbox: equals (numbers and yes/no normalized)
 *   cf.<fieldId>.empty=1   no value (0: has a value)
 * The field's type is read in SQL, so no lookup is needed here. At most 10 field conditions.
 */
export function fieldConditions(q) {
  const out = [];
  for (const [k, raw] of Object.entries(q || {})) {
    const m = CF_QUERY_RE.exec(k);
    if (!m || raw === undefined || raw === null || raw === '') continue;
    if (out.length >= MAX_FILTERS) break;
    const v = String(raw);
    if (m[2]) {
      if (v !== '1' && v !== '0') continue;
      out.push({
        sql: `${v === '1' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM issue_field_values fv WHERE fv.issue_id = i.id AND fv.field_id = ?)`,
        params: [m[1]],
      });
      continue;
    }
    const text = v.trim().slice(0, 500);
    if (!text) continue;
    out.push({
      sql: `EXISTS (SELECT 1 FROM issue_field_values fv JOIN custom_fields cfd ON cfd.id = fv.field_id WHERE fv.issue_id = i.id AND fv.field_id = ? AND (
        (cfd.type IN ('text', 'longtext', 'url') AND LOWER(fv.value) LIKE ? ESCAPE '\\')
        OR (cfd.type = 'multiselect' AND fv.value LIKE ? ESCAPE '\\')
        OR (cfd.type NOT IN ('text', 'longtext', 'url', 'multiselect') AND fv.value = ?)))`,
      params: [m[1], `%${likeEscape(text.toLowerCase())}%`, `%${likeEscape(JSON.stringify(text))}%`, exactParam(text)],
    });
  }
  return out;
}

/** Copy cf.* search parameters of `q` into `out` (saved queries of feeds and reports). */
export function copyFieldQuery(q, out) {
  let n = 0;
  for (const [k, v] of Object.entries(q || {})) {
    if (!CF_QUERY_RE.test(k) || v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') fail(400, `query.${k} must be text`);
    const s = String(v).trim();
    if (s.length > 500) fail(400, `query.${k} is too long`);
    if (s && n++ < MAX_FILTERS) out[k] = s;
  }
  return out;
}

/** A field the user can see (its project is visible), or null. visible: visibleProjectsSql(user). */
export async function visibleField(db, visible, fieldId) {
  if (!FIELD_ID_RE.test(String(fieldId || ''))) return null;
  const r = await db.get(`SELECT f.* FROM custom_fields f JOIN projects p ON p.id = f.project_id WHERE f.id = ? AND ${visible.sql}`, [
    fieldId,
    ...visible.params,
  ]);
  return r ? fieldOut(r) : null;
}

/** A stored value back in API form (template defaults): option ids, lists, booleans, numbers, user ids, text. */
export function apiValue(field, text) {
  if (text === null || text === undefined) return null;
  if (field.type === 'multiselect') return parseJson(text, []);
  if (field.type === 'checkbox') return text === '1';
  if (field.type === 'number') return Number(text);
  return text;
}

/** Template default values from a body: checked like issue values, stored as JSON {fieldId: API value}. */
export async function readTemplateFields(db, projectId, input, type) {
  if (input === null) return '{}';
  const fields = await listFields(db, projectId);
  const values = await readFieldValues(db, projectId, input, { type, fields });
  const out = {};
  for (const [fid, text] of values)
    if (text !== null)
      out[fid] = apiValue(
        fields.find((f) => f.id === fid),
        text,
      );
  return JSON.stringify(out);
}

// ---------- definitions (Project settings > Fields) ----------

const bool = (v) => v === true || v === 1 || v === '1' || v === 'true';

/** Check a field definition from a create (current = null) or update body. Returns column values. */
export function readDefinition(b, current, newId) {
  const out = {};
  if (!current || b.name !== undefined) {
    if (typeof b.name !== 'string' || !b.name.trim()) fail(400, 'Name is required');
    const name = b.name.trim();
    if (name.length > 60) fail(400, 'Name is too long (max 60 characters)');
    out.name = name;
  }
  if (!current) {
    if (!FIELD_TYPES.includes(b.type)) fail(400, `Type must be one of: ${FIELD_TYPES.join(', ')}`);
    out.type = b.type;
  } else if (b.type !== undefined && b.type !== current.type)
    fail(400, 'The type of a field cannot be changed. Create a new field instead.');
  const type = out.type || current.type;
  if (b.help !== undefined) {
    if (b.help !== null && typeof b.help !== 'string') fail(400, 'Help text must be text');
    const h = (b.help || '').trim();
    if (h.length > 300) fail(400, 'Help text is too long (max 300 characters)');
    out.help = h || null;
  }
  if (b.required !== undefined) out.required = bool(b.required) ? 1 : 0;
  if (b.archived !== undefined) out.archived = bool(b.archived) ? 1 : 0;
  if (b.issueTypes !== undefined) {
    if (b.issueTypes !== null && !Array.isArray(b.issueTypes)) fail(400, 'issueTypes must be a list of issue types');
    const list = [...new Set(b.issueTypes || [])];
    for (const t of list) if (!ISSUE_TYPES.includes(t)) fail(400, `Issue types must be some of: ${ISSUE_TYPES.join(', ')}`);
    out.issue_types = JSON.stringify(ISSUE_TYPES.filter((t) => list.includes(t)));
  }
  if (b.position !== undefined) {
    const p = Number(b.position);
    if (!Number.isInteger(p) || p < 0 || p > 1000) fail(400, 'position must be a whole number');
    out.position = p;
  }
  if (OPTION_TYPES.includes(type)) {
    if (!current || b.options !== undefined)
      out.options = JSON.stringify(readOptions(b.options, current ? fieldOut(current).options : [], newId));
  } else if (b.options !== undefined && Array.isArray(b.options) && b.options.length)
    fail(400, 'Only select and multi-select fields have options');
  return out;
}

/**
 * Options from the body: a list of names or { id, name, archived }. Existing ids keep their identity (a rename keeps
 * values); options left out of the list are kept as archived at the end, so stored values never lose their name.
 */
function readOptions(input, existing, newId) {
  if (!Array.isArray(input)) fail(400, 'options must be a list');
  const known = new Map(existing.map((o) => [o.id, o]));
  const out = [];
  const names = new Set();
  for (const raw of input) {
    const o = typeof raw === 'string' ? { name: raw } : raw;
    if (!o || typeof o !== 'object') fail(400, 'Each option needs a name');
    const name = String(o.name ?? '').trim();
    if (!name) fail(400, 'Each option needs a name');
    if (name.length > 80) fail(400, 'Option names are at most 80 characters');
    if (names.has(name.toLowerCase())) fail(400, `The option "${name}" is listed twice`);
    names.add(name.toLowerCase());
    let id = o.id;
    if (id !== undefined && id !== null && id !== '') {
      if (!known.has(id)) fail(400, `Unknown option id: ${id}`);
      if (out.some((x) => x.id === id)) fail(400, 'An option is listed twice');
    } else id = newId();
    out.push({ id, name, archived: bool(o.archived) });
  }
  for (const o of existing) {
    if (out.some((x) => x.id === o.id)) continue;
    let name = o.name;
    for (let n = 2; names.has(name.toLowerCase()); n++) name = `${o.name} (${n})`;
    names.add(name.toLowerCase());
    out.push({ id: o.id, name, archived: true });
  }
  if (out.length > MAX_OPTIONS) fail(400, `At most ${MAX_OPTIONS} options`);
  if (!out.some((o) => !o.archived)) fail(400, 'Add at least one option');
  return out;
}
