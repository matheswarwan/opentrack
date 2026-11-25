// Small SQL helpers shared by every query builder.
//
// Cloudflare D1 allows at most MAX_BOUND bound values ("?") per statement, so long id lists and multi-row inserts
// are split: IN lists take IN_CHUNK values at a time (the rest of the room is for the query's other values), and
// insertRows keeps each INSERT under the same number.

export const MAX_BOUND = 100;
export const IN_CHUNK = 80;

/**
 * The condition that leaves out rows in the Trash (issues and projects have deleted_at): notDeleted('i') is
 * "i.deleted_at IS NULL", notDeleted() is the bare column for a query without aliases.
 */
export const notDeleted = (alias = '') => `${alias ? `${alias}.` : ''}deleted_at IS NULL`;

/** "?, ?, ?" for n values. */
export function placeholders(n) {
  return Array.from({ length: n }, () => '?').join(', ');
}

/** Split a list into parts of at most `size` items (no parts for an empty list). */
export function chunks(list, size = IN_CHUNK) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * A query with a long IN list, run once per part of the list, one after the other: run(part) returns that part's
 * rows, and all rows come back together. For example:
 *   inChunks(ids, (part) => db.all(`SELECT ... WHERE id IN (${placeholders(part.length)})`, part))
 */
export async function inChunks(list, run, size = IN_CHUNK) {
  const out = [];
  for (const part of chunks(list, size)) out.push(...(await run(part)));
  return out;
}

/**
 * Multi-row INSERT statements for `rows` (arrays of values, one per column), split so no statement binds more than
 * `bound` values. suffix: text after the VALUES list, such as ' ON CONFLICT DO NOTHING'. Returns [{ sql, params }].
 */
export function insertRows(table, cols, rows, { suffix = '', bound = IN_CHUNK } = {}) {
  const per = Math.max(1, Math.floor(bound / cols.length));
  return chunks(rows, per).map((part) => ({
    sql: `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${part.map(() => `(${placeholders(cols.length)})`).join(', ')}${suffix}`,
    params: part.flat(),
  }));
}
