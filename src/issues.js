// Changing an issue from the web app: the one place that sends PATCH /api/issues/:key.
import { patch, toast } from './api.js';
import { changed } from './ui.js';
import { withWorkflow } from './workflow.js';

/** Save a change. Resolves to the server's answer { issue, changed: [field names] }; rejects when it is refused. */
export const updateIssue = (key, change) => patch(`/api/issues/${key}`, change);

/**
 * Move an issue to another status under the project's workflow rules: when a rule needs values the issue
 * does not have, the dialog (TransitionDialog) asks for them and the change is sent again with them.
 * `project` is the project payload (statuses, workflow, fields). Rejects like updateIssue; a cancelled
 * dialog rejects with an error whose `cancelled` is true.
 */
export const changeStatus = (project, issue, statusId) => withWorkflow(project, (extra) => updateIssue(issue.key, { ...extra, statusId }));

/**
 * Show a change at once and save it: the fields are set on the local issue object first, and put back
 * (with an error toast) when the server refuses. On success: the okMessage toast and changed(), so other
 * views reload. Resolves to true when it was saved.
 */
export async function patchOptimistic(issue, change, okMessage) {
  const before = Object.fromEntries(Object.keys(change).map((k) => [k, issue[k]]));
  Object.assign(issue, change);
  try {
    await updateIssue(issue.key, change);
    if (okMessage) toast(okMessage);
    changed();
    return true;
  } catch (e) {
    Object.assign(issue, before);
    toast(e.message, 'error');
    return false;
  }
}
