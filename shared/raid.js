// RAID log rules both sides use: types, statuses, what "active" and "overdue" mean, the risk score and its bands, and
// the fields the history records. The server adds storage (server/lib/raid.js); the browser adds colours (src/raid.js).
export const RAID_TYPES = ['risk', 'assumption', 'issue', 'decision'];
export const TYPE_LABELS = { risk: 'Risk', assumption: 'Assumption', issue: 'Issue', decision: 'Decision' };
export const ITEM_STATUSES = ['open', 'monitoring', 'closed'];
export const DECISION_STATUSES = ['proposed', 'agreed', 'superseded'];
export const STATUS_LABELS = {
  open: 'Open',
  monitoring: 'Monitoring',
  closed: 'Closed',
  proposed: 'Proposed',
  agreed: 'Agreed',
  superseded: 'Superseded',
};
export const INACTIVE = ['closed', 'superseded'];

export const statusesFor = (type) => (type === 'decision' ? DECISION_STATUSES : ITEM_STATUSES);
export const defaultStatus = (type) => statusesFor(type)[0];
export const isActiveStatus = (status) => !INACTIVE.includes(status);
export const refOf = (n) => `RAID-${n}`;

/** Probability x impact (each 1 to 5), or null when either is missing. */
export const riskScore = (p, i) => (p && i ? Number(p) * Number(i) : null);
/** Score bands: high 12 or more (also the status report's "Top risks" cut-off), medium 5 to 11, low 1 to 4. */
export const HIGH_SCORE = 12;
export const MEDIUM_SCORE = 5;
export const scoreBand = (score) => (!score ? null : score >= HIGH_SCORE ? 'high' : score >= MEDIUM_SCORE ? 'medium' : 'low');

/** Is the entry past its review date (and still active)? today: YYYY-MM-DD. */
export const isOverdue = (e, today) => Boolean(e.reviewDate) && e.active && e.reviewDate < today;

/** Fields kept in the history, with how they are shown. LONG_FIELDS are recorded without their text in the sentence. */
export const HISTORY_FIELDS = {
  type: 'Type',
  title: 'Title',
  description: 'Description',
  owner_id: 'Owner',
  status: 'Status',
  review_date: 'Review date',
  probability: 'Probability',
  impact: 'Impact',
  mitigation: 'Mitigation',
  contingency: 'Contingency',
  decided_by: 'Decided by',
  decided_on: 'Decided on',
  rationale: 'Rationale',
  links: 'Linked issues',
};
export const LONG_FIELDS = ['description', 'mitigation', 'contingency', 'rationale'];
