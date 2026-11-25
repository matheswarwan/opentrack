// Workflow transition rules (server/lib/workflow.js validates and stores them; src/workflow.js dims board columns).
// wf: { transitions: null | { fromId: [toId] }, adminBypass }.

/** May an issue move from one status to another under these rules (ignoring the admin bypass)? */
export function transitionAllowed(wf, from, to) {
  if (!wf?.transitions || from === to) return true;
  const list = wf.transitions[from];
  return !Array.isArray(list) || list.includes(to);
}

/** The refusal message. fromName, toName: status names; allowedNames: names of the statuses it may move to. */
export const refusalText = (fromName, toName, allowedNames) =>
  `Moving from ${fromName || 'this status'} to ${toName || 'this status'} is not allowed. Allowed: ${allowedNames.join(', ') || 'none'}.`;
