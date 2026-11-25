// The audit log (audit_log table): one statement builder used by every writer.
import { uuid, now } from './crypto.js';

/** An audit_log insert, to put in the same batch as the change it records. at: the time of the change (default now). */
export function audit(actorId, action, targetType, targetId, details, at = now()) {
  return {
    sql: 'INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    params: [uuid(), actorId, action, targetType, targetId, details ? JSON.stringify(details) : null, at],
  };
}
