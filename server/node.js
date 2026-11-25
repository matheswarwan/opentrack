// Node host (Google Cloud Run, or local). DATABASE_URL=postgres://... uses Postgres;
// otherwise a local SQLite file (SQLITE_PATH, default ./data/tracker.db).
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { sqliteAdapter, pgAdapter } from './db/adapters.js';
import { migrate } from './db/migrate.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function openDb() {
  if (process.env.DATABASE_URL) {
    const { default: pg } = await import('pg');
    return pgAdapter(new pg.Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.DB_POOL || 10) }));
  }
  const { DatabaseSync } = await import('node:sqlite');
  const file = process.env.SQLITE_PATH || join(root, 'data/tracker.db');
  mkdirSync(dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  return sqliteAdapter(raw);
}

const db = await openDb();
const applied = await migrate(db);
if (applied.length) console.log('migrations applied:', applied.join(', '));

const env = { ...process.env, db };
const api = createApp();
const server = new Hono();
server.all('/api/*', (c) => api.fetch(c.req.raw, env));
server.all('/auth/*', (c) => api.fetch(c.req.raw, env));
server.all('/mcp', (c) => api.fetch(c.req.raw, env));
server.all('/oauth/*', (c) => api.fetch(c.req.raw, env));
server.all('/.well-known/*', (c) => api.fetch(c.req.raw, env));
server.all('/feeds/*', (c) => api.fetch(c.req.raw, env));
server.all('/slack/*', (c) => api.fetch(c.req.raw, env));
const dist = join(root, 'dist');
if (existsSync(dist)) {
  server.use('/*', serveStatic({ root: 'dist' }));
  const index = readFileSync(join(dist, 'index.html'), 'utf8');
  server.get('*', (c) => c.html(index));
}

const port = Number(process.env.PORT || 8787);
serve({ fetch: server.fetch, port, hostname: process.env.HOST || '127.0.0.1' });
console.log(`opentrack listening on http://${process.env.HOST || '127.0.0.1'}:${port}`);
