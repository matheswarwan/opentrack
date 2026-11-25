// Workflow rules in the web app (server/lib/workflow.js). The project payload has
// workflow: { transitions: null | { fromId: [toId] }, adminBypass, required: { statusId: [keys] } }.
import { reactive } from 'vue';
import { transitionAllowed, refusalText } from '../shared/workflow.js';

/** Can the current person move an issue of this project from one status to another? */
export function canMoveTo(project, from, to) {
  const wf = project?.workflow;
  if (wf?.transitions && project.canAdmin && wf.adminBypass) return true;
  return transitionAllowed(wf, from, to);
}

/** The refusal text, as the server words it. */
export function moveRefusal(project, from, to) {
  const name = (id) => project.statuses.find((s) => s.id === id)?.name;
  return refusalText(
    name(from),
    name(to),
    (project.workflow?.transitions?.[from] || []).map((id) => name(id) || 'this status'),
  );
}

// The "values needed" dialog (components/TransitionDialog.vue, mounted once in App.vue).
export const transition = reactive({ open: false, project: null, status: null, missing: [], resolve: null });

function askMissing(project, data) {
  return new Promise((resolve) => {
    Object.assign(transition, { open: true, project, status: data.status, missing: data.missing || [], resolve });
  });
}

/**
 * Run a status change. send(extra) makes the request; when a rule needs values the issue does not have, the dialog
 * asks for them and the change is sent once more with them. A cancelled dialog throws an error with cancelled = true.
 */
export async function withWorkflow(project, send) {
  try {
    return await send({});
  } catch (e) {
    if (e.data?.code !== 'required') throw e;
    const values = await askMissing(project, e.data);
    if (!values) {
      const err = new Error('Cancelled');
      err.cancelled = true;
      throw err;
    }
    return send(values);
  }
}
