// Issue templates: the rules shared by the template routes, recurring rules and the MCP create_issue tool.
export const MAX_SUBTASKS = 20;
// Only these types can have sub-tasks.
export const SUBTASK_PARENTS = ['story', 'task', 'bug'];

/** The summary with a template's prefix or {title} pattern applied (once). */
export function applyTitlePrefix(prefix, title = '') {
  const t = String(title || '');
  if (!prefix) return t;
  if (prefix.includes('{title}')) return prefix.replace('{title}', t);
  return t.startsWith(prefix) ? t : prefix + t;
}
