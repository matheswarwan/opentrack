// Database adapters. Every adapter exposes the same async interface:
//   all(sql, params)   -> array of row objects
//   get(sql, params)   -> first row or null
//   run(sql, params)   -> { changes }
//   batch([{ sql, params }]) -> runs all statements in one transaction
// SQL uses `?` placeholders; the Postgres adapter rewrites them to $1, $2, ...

function clean(params = []) {
  return params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
}

/** Cloudflare D1 binding. */
export function d1Adapter(d1) {
  const prep = (sql, params) => d1.prepare(sql).bind(...clean(params));
  return {
    dialect: 'sqlite',
    async all(sql, params) {
      const r = await prep(sql, params).all();
      return r.results || [];
    },
    async get(sql, params) {
      return (await prep(sql, params).first()) ?? null;
    },
    async run(sql, params) {
      const r = await prep(sql, params).run();
      return { changes: r.meta?.changes ?? 0 };
    },
    async batch(stmts) {
      if (!stmts.length) return [];
      return d1.batch(stmts.map((s) => prep(s.sql, s.params)));
    },
  };
}

/** node:sqlite DatabaseSync (tests and local development). */
export function sqliteAdapter(db) {
  const plain = (row) => (row ? { ...row } : null);
  return {
    dialect: 'sqlite',
    raw: db,
    async all(sql, params) {
      return db
        .prepare(sql)
        .all(...clean(params))
        .map(plain);
    },
    async get(sql, params) {
      return plain(db.prepare(sql).get(...clean(params)));
    },
    async run(sql, params) {
      const r = db.prepare(sql).run(...clean(params));
      return { changes: Number(r.changes) };
    },
    async batch(stmts) {
      if (!stmts.length) return [];
      db.exec('BEGIN');
      try {
        for (const s of stmts) db.prepare(s.sql).run(...clean(s.params));
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return [];
    },
  };
}

export function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

/** node-postgres Pool (Google Cloud: Cloud SQL). */
export function pgAdapter(pool) {
  return {
    dialect: 'postgres',
    async all(sql, params) {
      return (await pool.query(toPg(sql), clean(params))).rows;
    },
    async get(sql, params) {
      return (await pool.query(toPg(sql), clean(params))).rows[0] ?? null;
    },
    async run(sql, params) {
      const r = await pool.query(toPg(sql), clean(params));
      return { changes: r.rowCount ?? 0 };
    },
    async batch(stmts) {
      if (!stmts.length) return [];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const s of stmts) await client.query(toPg(s.sql), clean(s.params));
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      return [];
    },
  };
}

/** Split a migration file into statements (no semicolons inside our SQL strings). */
export function splitSql(text) {
  return text
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}
