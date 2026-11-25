// Jira import: limits, small text helpers, how Jira values map to ours (priority, type, status category, link
// type), the jira_import_map row shape, and matching Jira people to users. No database or network calls here.
import { insertRows as sqlInsertRows } from '../../db/sql.js';

export const JIRA_MAX_FILE = 10 * 1024 * 1024;

export const MAX_LISTED = 200; // people and too-big files kept in the dry run
export const MAX_PARAMS = 90; // D1: at most 100 bound values per statement

/** ISO time from Jira's "2024-01-02T03:04:05.000+0000". */
export function jiraTime(v) {
  if (!v) return null;
  const d = new Date(String(v).replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export const cut = (s, max, note = '\n\n(Cut: the rest is in Jira.)') => (s && s.length > max ? s.slice(0, max - note.length) + note : s);

export function cleanSite(v) {
  let s = String(v || '')
    .trim()
    .toLowerCase()
    .replace(/\/+$/, '');
  if (!s) return null;
  if (!/^https?:\/\//.test(s)) s = s.includes('.') ? `https://${s}` : `https://${s}.atlassian.net`;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.port || u.username || !/^[a-z0-9][a-z0-9-]*\.(atlassian\.net|jira\.com)$/.test(u.hostname)) return null;
  return `https://${u.hostname}`;
}

export const KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;

/** A free project key close to Jira's key. */
export function suggestKey(jiraKey, taken) {
  let base = String(jiraKey || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z]/.test(base)) base = `J${base}`;
  base = base.slice(0, 10);
  if (base.length < 2) base = `${base}J`;
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const k = base.slice(0, 10 - String(i).length) + i;
    if (!taken.has(k)) return k;
  }
  return null;
}

export function mapPriority(name) {
  const n = String(name || '').toLowerCase();
  if (n === 'highest' || n === 'blocker') return 'highest';
  if (n === 'high' || n === 'critical') return 'high';
  if (n === 'low' || n === 'minor') return 'low';
  if (n === 'lowest' || n === 'trivial') return 'lowest';
  return 'medium';
}

export function mapType(t) {
  if (!t) return 'task';
  if (t.subtask) return 'subtask';
  const n = String(t.name || '').toLowerCase();
  if (n === 'epic' || t.hierarchyLevel === 1) return 'epic';
  if (n.includes('story')) return 'story';
  if (n.includes('bug')) return 'bug';
  return 'task';
}

export const mapCategory = (key) => (key === 'done' ? 'done' : key === 'indeterminate' ? 'in_progress' : 'todo');

export function mapLinkType(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('block')) return 'blocks';
  if (n.includes('dup')) return 'duplicates';
  if (n.includes('clon')) return 'clones';
  return 'relates';
}

/** Multi-row INSERT statements, each under this import's bound-value limit (server/db/sql.js). */
export const insertRows = (table, cols, rows, suffix = '') => sqlInsertRows(table, cols, rows, { suffix, bound: MAX_PARAMS });

export const mapRow = (importId, kind, jiraId, localId, jiraKey = null, localKey = null, data = null) => [
  importId,
  kind,
  String(jiraId),
  localId,
  jiraKey,
  localKey,
  data,
];
export const MAP_COLS = ['import_id', 'kind', 'jira_id', 'local_id', 'jira_key', 'local_key', 'data'];

/** Match Jira people to active users: email first, else a name only one user has. */
export function matchPeople(people, users) {
  const byEmail = new Map();
  const byName = new Map();
  const byId = new Map();
  for (const u of users) {
    byId.set(u.id, u);
    if (u.status === 'deactivated') continue;
    byEmail.set(u.email.toLowerCase(), u);
    const n = u.name.trim().toLowerCase();
    byName.set(n, [...(byName.get(n) || []), u]);
  }
  for (const p of Object.values(people)) {
    if (p.userId && byId.has(p.userId) && byId.get(p.userId).status !== 'deactivated') continue;
    p.userId = null;
    const e = p.email && byEmail.get(p.email.toLowerCase());
    if (e) {
      p.userId = e.id;
      p.how = 'email';
      continue;
    }
    const named =
      byName.get(
        String(p.name || '')
          .trim()
          .toLowerCase(),
      ) || [];
    if (named.length === 1) {
      p.userId = named[0].id;
      p.how = 'name';
    }
  }
  return people;
}

export function notePerson(people, a) {
  if (!a || !a.accountId) return null;
  const p =
    people[a.accountId] ||
    (people[a.accountId] = { accountId: a.accountId, name: a.displayName || 'Unknown', email: a.emailAddress || null, userId: null });
  if (!p.email && a.emailAddress) p.email = a.emailAddress;
  return p;
}
