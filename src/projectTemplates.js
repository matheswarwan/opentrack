// Words for what a project template sets up (server/lib/projectTemplates.js bodySummary).
import { counted as plural } from './plural.js';

/** ["5 statuses", "workflow rules", "3 fields", ...] */
export function templateParts(s) {
  if (!s) return [];
  const out = [plural(s.statuses.length, 'status', 'statuses')];
  if (s.workflowRules) out.push('workflow rules');
  if (s.fields.length) out.push(plural(s.fields.length, 'field'));
  if (s.components) out.push(plural(s.components, 'component'));
  if (s.issueTemplates.length) out.push(plural(s.issueTemplates.length, 'issue template'));
  if (s.recurring.length) out.push(plural(s.recurring.length, 'recurring task'));
  if (s.epics) out.push(plural(s.epics, 'epic'));
  if (s.stories) out.push(plural(s.stories, 'story', 'stories'));
  if (s.tasks) out.push(plural(s.tasks, 'task'));
  if (s.bugs) out.push(plural(s.bugs, 'bug'));
  if (s.sprint) out.push('a first sprint');
  return out;
}

/** Does applying it use the start date? */
export const usesDates = (s) => Boolean(s && (s.epics || s.stories || s.tasks || s.bugs || s.sprint || s.recurring.length));

export const joinParts = (parts) =>
  parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
