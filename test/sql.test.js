// server/db/sql.js: placeholders, chunked IN lists and multi-row inserts under D1's bound-value limit.
import { describe, it, expect } from 'vitest';
import { MAX_BOUND, IN_CHUNK, placeholders, chunks, inChunks, insertRows, notDeleted } from '../server/db/sql.js';
import { visibleProjectsSql } from '../server/lib/access.js';
import { issueFilter } from '../server/lib/issues/search.js';
import { ISSUE_FROM, ISSUE_SELECT } from '../server/lib/issues/model.js';

describe('notDeleted', () => {
  it('writes the Trash condition with or without an alias', () => {
    expect(notDeleted('i')).toBe('i.deleted_at IS NULL');
    expect(notDeleted()).toBe('deleted_at IS NULL');
  });
});

describe('SQL fragments with aliases', () => {
  const member = { id: 'u1', role: 'member' };
  it('visibleProjectsSql writes its conditions against the alias it is given', () => {
    const p = visibleProjectsSql(member);
    expect(p.sql).toBe(
      "p.deleted_at IS NULL AND (p.visibility = 'open' OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.user_id = ?))",
    );
    const sp = visibleProjectsSql(member, 'sp');
    expect(sp.sql).toBe(p.sql.replace(/\bp\./g, 'sp.'));
    expect(sp.params).toEqual(p.params);
    const scoped = visibleProjectsSql({ ...member, projectScope: ['a', 'b'] }, 'tp');
    expect(scoped.sql).toContain('tp.id IN (?, ?)');
    expect(scoped.sql).not.toMatch(/\bp\./);
    expect(visibleProjectsSql({ id: 'g', role: 'guest' }, 'x').sql).toBe(
      'x.deleted_at IS NULL AND EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = x.id AND m.user_id = ?)',
    );
  });

  it('issueFilter hands back the FROM its conditions are written against', () => {
    const f = issueFilter(member, { project: 'WEB' });
    expect(f.from).toBe(ISSUE_FROM);
    expect(f.from.startsWith('FROM issues i JOIN projects p')).toBe(true);
    expect(ISSUE_SELECT.endsWith(ISSUE_FROM)).toBe(true);
    expect(f.where.startsWith('i.deleted_at IS NULL AND p.deleted_at IS NULL')).toBe(true);
    expect(f.params).toEqual(['u1', 'WEB']);
  });
});

describe('sql helpers', () => {
  it('writes placeholders', () => {
    expect(placeholders(3)).toBe('?, ?, ?');
    expect(placeholders(1)).toBe('?');
    expect(placeholders(0)).toBe('');
  });

  it('splits lists, 80 at a time unless told otherwise', () => {
    expect(IN_CHUNK).toBeLessThan(MAX_BOUND);
    const ids = Array.from({ length: 170 }, (_, i) => i);
    expect(chunks(ids).map((p) => p.length)).toEqual([80, 80, 10]);
    expect(chunks(ids, 100).map((p) => p.length)).toEqual([100, 70]);
    expect(chunks(ids).flat()).toEqual(ids);
    expect(chunks([])).toEqual([]);
  });

  it('runs a query per part, in order, and joins the rows', async () => {
    const seen = [];
    const rows = await inChunks(
      [1, 2, 3, 4, 5],
      async (part) => {
        seen.push(part);
        return part.map((x) => ({ x }));
      },
      2,
    );
    expect(seen).toEqual([[1, 2], [3, 4], [5]]);
    expect(rows.map((r) => r.x)).toEqual([1, 2, 3, 4, 5]);
    expect(
      await inChunks([], async () => {
        throw new Error('not called');
      }),
    ).toEqual([]);
  });

  it('builds multi-row inserts under the bound', () => {
    const rows = Array.from({ length: 30 }, (_, i) => [i, 'a', 'b']);
    const st = insertRows('t', ['id', 'x', 'y'], rows);
    expect(st.map((s) => s.params.length)).toEqual([78, 12]); // 26 rows of 3 values, then 4
    expect(st[1].sql).toBe('INSERT INTO t (id, x, y) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?)');
    expect(st.flatMap((s) => s.params).filter((v) => typeof v === 'number')).toEqual(rows.map((r) => r[0]));
    expect(insertRows('t', ['id'], [])).toEqual([]);
    const wide = insertRows('t', ['id', 'x', 'y'], rows, { suffix: ' ON CONFLICT DO NOTHING', bound: 90 });
    expect(wide.map((s) => s.params.length)).toEqual([90]);
    expect(wide[0].sql.endsWith(' ON CONFLICT DO NOTHING')).toBe(true);
    // more columns than the bound: still one row per statement
    expect(
      insertRows(
        't',
        ['a', 'b', 'c'],
        [
          [1, 2, 3],
          [4, 5, 6],
        ],
        { bound: 2 },
      ),
    ).toHaveLength(2);
  });
});
