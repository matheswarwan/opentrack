// Issue history rows (the issue_history table) and where a change came from.
//
// source: null for the web app and plain API calls, 'mcp' for changes made by an AI assistant through /mcp. The MCP
// server calls the normal routes with env.changeSource set (server/mcp.js), and the inserts of history rows,
// comments and work logs stamp it as they write: nothing is tagged after the fact.
import { uuid } from './crypto.js';

/** The source to stamp on rows this request writes ('mcp' or null). */
export const changeSource = (c) => c?.env?.changeSource || null;

/** One issue_history insert. from / to are the display values (null when there is none). */
export function historyStmt(issueId, actorId, field, from, to, at, source = null) {
  return {
    sql: 'INSERT INTO issue_history (id, issue_id, actor_id, field, old_value, new_value, created_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    params: [uuid(), issueId, actorId, field, from ?? null, to ?? null, at, source],
  };
}
