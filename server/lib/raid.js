// RAID log: risks, assumptions, issues and decisions kept per project (migration 0029, routes in server/routes/raid.js).
//
// Rights: project members read, members who can edit issues create and edit, project admins delete. Viewers read
// only. Guests never see the RAID log (every RAID endpoint answers 404 for them), and a guest cannot be an owner.
// Risks carry probability and impact (1 to 5) and score = probability x impact. "Active" entries are the ones
// still being worked: every status but closed and superseded.
import { uuid } from './crypto.js';
import { insertRows } from '../db/sql.js';
import { TYPE_LABELS, INACTIVE, HIGH_SCORE, isActiveStatus, refOf } from '../../shared/raid.js';

// Types, statuses, scoring, overdue and history fields are shared with the web app (shared/raid.js).
export {
  RAID_TYPES,
  TYPE_LABELS,
  ITEM_STATUSES,
  DECISION_STATUSES,
  INACTIVE,
  statusesFor,
  defaultStatus,
  riskScore,
  refOf,
  isOverdue,
  HISTORY_FIELDS,
} from '../../shared/raid.js';
export const TOP_RISK_SCORE = HIGH_SCORE; // status report "Top risks": active risks at or above this score
export const TOP_RISK_COUNT = 5;
export const MAX_LINKS = 40; // one multi-row insert stays at 80 bound values
export const MAX_ENTRIES = 1000; // per list request

/** An entry row (with owner_name, links) for the API. */
export function entryOut(r, links = []) {
  return {
    id: r.id,
    number: Number(r.number),
    ref: refOf(r.number),
    type: r.type,
    title: r.title,
    description: r.description || '',
    owner: r.owner_id ? { id: r.owner_id, name: r.owner_name || 'Former user' } : null,
    status: r.status,
    active: isActiveStatus(r.status),
    reviewDate: r.review_date || null,
    probability: r.probability === null || r.probability === undefined ? null : Number(r.probability),
    impact: r.impact === null || r.impact === undefined ? null : Number(r.impact),
    score: r.score === null || r.score === undefined ? null : Number(r.score),
    mitigation: r.mitigation || '',
    contingency: r.contingency || '',
    decidedBy: r.decided_by || '',
    decidedOn: r.decided_on || null,
    rationale: r.rationale || '',
    links,
    createdBy: r.created_by ? { id: r.created_by, name: r.creator_name || 'Former user' } : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// SQL condition for active entries (constant values from shared/raid.js, no user input).
const ACTIVE_SQL = `r.status NOT IN (${INACTIVE.map((s) => `'${s}'`).join(', ')})`;

const cut = (v) => (v === null || v === undefined ? null : String(v).slice(0, 2000));

/** raid_history rows for a change set: [{ field, from, to }] -> statements. */
export function historyStatements(raidId, actorId, changes, t) {
  return insertRows(
    'raid_history',
    ['id', 'raid_id', 'actor_id', 'field', 'old_value', 'new_value', 'created_at', 'seq'],
    changes.map((ch, i) => [uuid(), raidId, actorId, ch.field, cut(ch.from), cut(ch.to), t, i]),
  );
}

/** Active risks with score >= TOP_RISK_SCORE, highest first (status report draft). One query. */
export async function topRisks(db, projectId, limit = TOP_RISK_COUNT) {
  return db.all(
    `SELECT r.id, r.number, r.title, r.probability, r.impact, r.score, r.status, r.review_date, u.name AS owner_name
       FROM raid_entries r LEFT JOIN users u ON u.id = r.owner_id
      WHERE r.project_id = ? AND r.type = 'risk' AND ${ACTIVE_SQL} AND r.score >= ?
      ORDER BY r.score DESC, r.review_date IS NULL, r.review_date, r.number LIMIT ?`,
    [projectId, TOP_RISK_SCORE, limit],
  );
}

/** A top risk as a status report section item. */
export function topRiskItem(r) {
  const bits = [`score ${r.score} (probability ${r.probability}, impact ${r.impact})`];
  if (r.owner_name) bits.push(`owner ${r.owner_name}`);
  if (r.status === 'monitoring') bits.push('monitoring');
  if (r.review_date) bits.push(`review ${r.review_date}`);
  return { id: r.id, title: `${refOf(r.number)} ${r.title}`, why: bits.join(', ') };
}

/** Active entries the user owns with a review date on or before `until` (due-date reminders). Projects they can see. */
export async function dueRaid(db, user, until, visible, limit = 20) {
  return db.all(
    `SELECT r.number, r.title, r.type, r.review_date, p.key AS project_key
       FROM raid_entries r JOIN projects p ON p.id = r.project_id
      WHERE r.owner_id = ? AND r.review_date IS NOT NULL AND r.review_date <= ? AND ${ACTIVE_SQL}
        AND p.archived = 0 AND ${visible.sql}
      ORDER BY r.review_date, p.key, r.number LIMIT ?`,
    [user.id, until, ...visible.params, limit],
  );
}

export const raidLabel = (r) => `${r.project_key} ${refOf(r.number)}`;

/** CSV columns of the export. */
export const CSV_COLUMNS = [
  ['Ref', (e) => e.ref],
  ['Type', (e) => TYPE_LABELS[e.type]],
  ['Title', (e) => e.title],
  ['Status', (e) => e.status],
  ['Owner', (e) => e.owner?.name || ''],
  ['Review date', (e) => e.reviewDate || ''],
  ['Probability', (e) => e.probability ?? ''],
  ['Impact', (e) => e.impact ?? ''],
  ['Score', (e) => e.score ?? ''],
  ['Mitigation', (e) => e.mitigation],
  ['Contingency', (e) => e.contingency],
  ['Decided by', (e) => e.decidedBy],
  ['Decided on', (e) => e.decidedOn || ''],
  ['Rationale', (e) => e.rationale],
  ['Linked issues', (e) => e.links.map((l) => l.key).join(' ')],
  ['Description', (e) => e.description],
  ['Created', (e) => e.createdAt],
  ['Updated', (e) => e.updatedAt],
];
