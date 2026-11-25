// Notice records, history and audit statement builders (server/lib/notifications.js, history.js, audit.js).
import { describe, it, expect } from 'vitest';
import { makeEnv } from './helpers.js';
import { notices, noticeStmts } from '../server/lib/notifications.js';
import { historyStmt, changeSource } from '../server/lib/history.js';
import { audit } from '../server/lib/audit.js';

describe('notices', () => {
  it('skips the actor, empty ids and repeats', () => {
    const list = notices(['u1', 'actor', null, 'u1', 'u2'], { type: 'comment', issueId: 'i1', actorId: 'actor', message: 'hello' });
    expect(list.map((n) => n.userId)).toEqual(['u1', 'u2']);
    expect(list[0]).toMatchObject({ type: 'comment', issueId: 'i1', actorId: 'actor', message: 'hello', projectId: null, link: null });
    expect(typeof list[0].at).toBe('string');
  });

  it('notifies the actor of a mention of themselves, with its own message', () => {
    const list = notices(['actor', 'u1'], {
      type: 'mentioned',
      issueId: 'i1',
      actorId: 'actor',
      message: 'A mentioned you',
      selfMessage: 'You mentioned yourself',
    });
    expect(list.map((n) => [n.userId, n.message])).toEqual([
      ['actor', 'You mentioned yourself'],
      ['u1', 'A mentioned you'],
    ]);
  });

  it('turns records into inserts that the database accepts', async () => {
    const { db } = await makeEnv();
    const t = '2026-06-15T10:00:00.000Z';
    await db.run(
      `INSERT INTO users (id, email, name, role, status, created_at, updated_at) VALUES ('u1', 'u1@example.com', 'U One', 'member', 'active', ?, ?)`,
      [t, t],
    );
    const stmts = noticeStmts([
      { userId: 'u1', type: 'webhook', message: 'bare' },
      { userId: 'u1', type: 'budget', message: 'full', at: t, link: '/projects/WEB/reports' },
    ]);
    expect(stmts).toHaveLength(2);
    await db.batch(stmts);
    const rows = await db.all(
      'SELECT user_id, type, issue_id, actor_id, message, created_at, project_id, link FROM notifications ORDER BY message',
    );
    expect(rows[0]).toMatchObject({
      user_id: 'u1',
      type: 'webhook',
      issue_id: null,
      actor_id: null,
      message: 'bare',
      project_id: null,
      link: null,
    });
    expect(rows[1]).toMatchObject({ type: 'budget', message: 'full', created_at: t, link: '/projects/WEB/reports' });
    expect(noticeStmts([])).toEqual([]);
  });
});

describe('history and audit statements', () => {
  it('builds a history insert with the source last', () => {
    const s = historyStmt('i1', 'u1', 'status', 'To Do', 'Done', '2026-06-15T10:00:00.000Z', 'mcp');
    expect(s.sql).toContain('INSERT INTO issue_history');
    expect(s.params.slice(1)).toEqual(['i1', 'u1', 'status', 'To Do', 'Done', '2026-06-15T10:00:00.000Z', 'mcp']);
    expect(historyStmt('i1', 'u1', 'created', undefined, 'WEB-1', 't').params.slice(4)).toEqual([null, 'WEB-1', 't', null]);
  });

  it('reads the change source from the env only', () => {
    expect(changeSource({ env: { changeSource: 'mcp' } })).toBe('mcp');
    expect(changeSource({ env: {} })).toBe(null);
    expect(changeSource(undefined)).toBe(null);
  });

  it('builds an audit insert, with the time given or now', () => {
    const a = audit('u1', 'issue.trashed', 'issue', 'i1', { key: 'WEB-1' }, '2026-06-15T10:00:00.000Z');
    expect(a.sql).toContain('INSERT INTO audit_log');
    expect(a.params.slice(1)).toEqual(['u1', 'issue.trashed', 'issue', 'i1', '{"key":"WEB-1"}', '2026-06-15T10:00:00.000Z']);
    const b = audit(null, 'settings.updated', 'settings', null);
    expect(b.params[5]).toBe(null);
    expect(Date.parse(b.params[6])).toBeGreaterThan(0);
  });
});
