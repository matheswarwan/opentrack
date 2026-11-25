// Applies migrations/*.sql in order and records them in schema_migrations.
// Used by the Node host (Postgres or SQLite). D1 uses `wrangler d1 migrations apply`.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitSql } from './adapters.js';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

export async function migrate(db, dir = MIGRATIONS_DIR) {
  await db.run('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set((await db.all('SELECT version FROM schema_migrations')).map((r) => r.version));
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const applied = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const stmts = splitSql(readFileSync(join(dir, f), 'utf8')).map((sql) => ({ sql, params: [] }));
    stmts.push({ sql: 'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', params: [f, new Date().toISOString()] });
    await db.batch(stmts);
    applied.push(f);
  }
  return applied;
}
