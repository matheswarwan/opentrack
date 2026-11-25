import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.js';
import { sqliteAdapter } from '../server/db/adapters.js';
import { migrate } from '../server/db/migrate.js';

export const SETUP_TOKEN = 'test-setup-token';
export const PASSWORD = 'correct horse battery';

export async function makeEnv(extra = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  const db = sqliteAdapter(raw);
  await migrate(db);
  const app = createApp();
  const env = { db, SETUP_TOKEN, JOBS_AUTO: 'off', ...extra }; // jobs run on request only in test/jobs.test.js
  return { app, env, db };
}

/** A browser-like client: keeps its session cookie, sends the CSRF header. */
export function client(ctx) {
  let cookie = '';
  async function call(method, path, data, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (cookie) headers.cookie = cookie;
    if (data !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET' && !opts.noCsrf) headers['x-requested-with'] = 'opentrack';
    const res = await ctx.app.request(path, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) }, ctx.env);
    const set = res.headers.get('set-cookie');
    if (set) {
      const m = set.match(/it_session=([^;]*)/);
      if (m) cookie = m[1] ? `it_session=${m[1]}` : '';
    }
    const type = res.headers.get('content-type') || '';
    const json = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, body: json, headers: res.headers };
  }
  return {
    get: (p, o) => call('GET', p, undefined, o),
    post: (p, d = {}, o) => call('POST', p, d, o),
    patch: (p, d = {}, o) => call('PATCH', p, d, o),
    put: (p, d = {}, o) => call('PUT', p, d, o),
    del: (p, o) => call('DELETE', p, undefined, o),
    delBody: (p, d = {}, o) => call('DELETE', p, d, o),
  };
}

/** Env with a first admin signed in. */
export async function withAdmin(extra) {
  const ctx = await makeEnv(extra);
  const admin = client(ctx);
  const r = await admin.post('/api/auth/setup', { token: SETUP_TOKEN, email: 'admin@example.com', name: 'Ada Admin', password: PASSWORD });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  return { ...ctx, admin };
}

/** Create a user through the admin API and sign them in. */
export async function addUser(ctx, { email, name, role = 'member' }) {
  const r = await ctx.admin.post('/api/admin/users', { email, name, role, password: PASSWORD });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  const c = client(ctx);
  const l = await c.post('/api/auth/login', { email, password: PASSWORD });
  if (l.status !== 200) throw new Error(JSON.stringify(l.body));
  return { client: c, id: r.body.user.id };
}
