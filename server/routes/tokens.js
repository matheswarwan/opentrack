import { body, fail, str, num } from '../lib/http.js';
import { uuid, now, sha256 } from '../lib/crypto.js';
import { newApiToken, parseScope } from '../lib/session.js';
import { audit } from '../lib/audit.js';
import { getSettings } from '../lib/settings.js';
import { visibleProjectsSql } from '../lib/access.js';
import { placeholders } from '../db/sql.js';
import { csvCell } from '../lib/csv.js';
import { parseJson } from '../lib/json.js';

const MAX_ACTIVE = 10;

function tokenStatus(t, at) {
  if (t.revoked_at) return 'revoked';
  if (t.expires_at && t.expires_at <= at) return 'expired';
  return 'active';
}

/** projects: map of project id to { id, key, name } for showing a token's scope. */
function out(t, projects, at) {
  const scope = parseScope(t.project_scope);
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    createdAt: t.created_at,
    expiresAt: t.expires_at,
    lastUsedAt: t.last_used_at,
    revokedAt: t.revoked_at || null,
    status: tokenStatus(t, at),
    scope: scope ? 'projects' : 'all',
    projects: scope ? scope.map((id) => projects.get(id) || { id, key: null, name: 'Deleted project' }) : [],
  };
}

function sessionOnly(c) {
  if (c.get('authVia') === 'token') fail(403, 'Manage API tokens in the web app');
  if (c.get('user').role === 'guest') fail(403, 'Guests cannot use API tokens or AI connectors');
}

export function registerTokens(app) {
  app.get('/api/me/tokens', async (c) => {
    sessionOnly(c);
    const db = c.env.db;
    const rows = await db.all("SELECT * FROM api_tokens WHERE user_id = ? AND kind = 'personal' ORDER BY created_at DESC LIMIT 100", [
      c.get('user').id,
    ]);
    const ids = [...new Set(rows.flatMap((t) => parseScope(t.project_scope) || []))];
    const projects = new Map();
    if (ids.length) {
      for (const p of await db.all(`SELECT id, key, name FROM projects WHERE id IN (${placeholders(ids.length)})`, ids))
        projects.set(p.id, p);
    }
    const s = await getSettings(db);
    const at = now();
    return c.json({ tokens: rows.map((t) => out(t, projects, at)), enabled: s.apiTokens });
  });

  // Create a token. The token itself is returned once and never stored.
  app.post('/api/me/tokens', async (c) => {
    sessionOnly(c);
    const db = c.env.db;
    if (!(await getSettings(db)).apiTokens) fail(403, 'An admin has turned off API tokens');
    const b = await body(c);
    const name = str(b.name, { required: true, max: 60, name: 'Name' });
    const days = num(b.expiresInDays, { name: 'Expiry', min: 1, max: 365 });
    const user = c.get('user');
    // projectIds: omitted or null = all projects you can see; else only these (each must be visible to you).
    let scope = null;
    if (b.projectIds !== undefined && b.projectIds !== null) {
      if (!Array.isArray(b.projectIds) || !b.projectIds.length) fail(400, 'Choose at least one project, or all projects');
      if (b.projectIds.length > 200) fail(400, 'Too many projects');
      const wanted = [...new Set(b.projectIds.map(String))];
      const v = visibleProjectsSql(user);
      const found = await db.all(`SELECT p.id FROM projects p WHERE ${v.sql} AND p.id IN (${placeholders(wanted.length)})`, [
        ...v.params,
        ...wanted,
      ]);
      if (found.length !== wanted.length) fail(400, 'One of the chosen projects was not found');
      scope = wanted;
    }
    const t = now();
    const n = await db.get(
      "SELECT CAST(COUNT(*) AS INTEGER) AS n FROM api_tokens WHERE user_id = ? AND kind = 'personal' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
      [user.id, t],
    );
    if (n.n >= MAX_ACTIVE) fail(400, `You have ${MAX_ACTIVE} active tokens. Revoke one first.`);
    const token = newApiToken();
    const id = uuid();
    const expires = days ? new Date(Date.now() + days * 864e5).toISOString() : null;
    await db.batch([
      {
        sql: 'INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, created_at, expires_at, project_scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        params: [id, user.id, name, await sha256(token), token.slice(0, 8), t, expires, scope ? JSON.stringify(scope) : null],
      },
      audit(user.id, 'token.created', 'user', user.id, { name, expires, projects: scope }),
    ]);
    return c.json(
      { token, id, name, prefix: token.slice(0, 8), expiresAt: expires, scope: scope ? 'projects' : 'all', projectIds: scope || [] },
      201,
    );
  });

  app.delete('/api/me/tokens/:id', async (c) => {
    sessionOnly(c);
    const user = c.get('user');
    // Revoked tokens stay listed (greyed out); tokenUser() refuses them.
    const db = c.env.db;
    const row = await db.get("SELECT id, revoked_at FROM api_tokens WHERE id = ? AND user_id = ? AND kind = 'personal'", [
      c.req.param('id'),
      user.id,
    ]);
    if (!row) fail(404, 'Token not found');
    if (row.revoked_at) return c.json({ ok: true });
    await db.run('UPDATE api_tokens SET revoked_at = ? WHERE id = ?', [now(), row.id]);
    await c.env.db.batch([audit(user.id, 'token.revoked', 'user', user.id, { id: c.req.param('id') })]);
    return c.json({ ok: true });
  });

  // OAuth apps (claude.ai, ChatGPT connectors) the user has allowed, from their live tokens.
  app.get('/api/me/connected-apps', async (c) => {
    sessionOnly(c);
    const db = c.env.db;
    const user = c.get('user');
    const t = now();
    const refresh = await db.all(
      `SELECT r.client_id, c.client_name, MIN(r.granted_at) AS granted_at, MAX(r.created_at) AS refreshed_at
         FROM oauth_refresh_tokens r JOIN oauth_clients c ON c.client_id = r.client_id
        WHERE r.user_id = ? AND r.expires_at > ? GROUP BY r.client_id, c.client_name`,
      [user.id, t],
    );
    const access = await db.all(
      `SELECT a.client_id, c.client_name, MIN(a.created_at) AS created_at, MAX(a.last_used_at) AS last_used_at
         FROM api_tokens a JOIN oauth_clients c ON c.client_id = a.client_id
        WHERE a.user_id = ? AND a.kind = 'oauth' AND a.expires_at > ? GROUP BY a.client_id, c.client_name`,
      [user.id, t],
    );
    const apps = new Map();
    const max = (a, b) => (!a ? b || null : !b ? a : a > b ? a : b);
    const min = (a, b) => (!a ? b || null : !b ? a : a < b ? a : b);
    for (const r of refresh)
      apps.set(r.client_id, {
        clientId: r.client_id,
        clientName: r.client_name || 'Unnamed app',
        authorizedAt: r.granted_at,
        lastUsedAt: r.refreshed_at,
      });
    for (const a of access) {
      const e = apps.get(a.client_id) || {
        clientId: a.client_id,
        clientName: a.client_name || 'Unnamed app',
        authorizedAt: a.created_at,
        lastUsedAt: null,
      };
      e.authorizedAt = min(e.authorizedAt, a.created_at);
      e.lastUsedAt = max(e.lastUsedAt, a.last_used_at);
      apps.set(a.client_id, e);
    }
    const list = [...apps.values()].sort((x, y) => (x.authorizedAt < y.authorizedAt ? 1 : -1));
    return c.json({ apps: list });
  });

  app.delete('/api/me/connected-apps/:clientId', async (c) => {
    sessionOnly(c);
    const db = c.env.db;
    const user = c.get('user');
    const id = c.req.param('clientId');
    const [client, has] = await Promise.all([
      db.get('SELECT client_name FROM oauth_clients WHERE client_id = ?', [id]),
      db.get(
        `SELECT (SELECT CAST(COUNT(*) AS INTEGER) FROM api_tokens WHERE user_id = ? AND client_id = ? AND kind = 'oauth') AS tokens,
                (SELECT CAST(COUNT(*) AS INTEGER) FROM oauth_refresh_tokens WHERE user_id = ? AND client_id = ?) AS refresh`,
        [user.id, id, user.id, id],
      ),
    ]);
    const codes = { sql: 'DELETE FROM oauth_codes WHERE user_id = ? AND client_id = ?', params: [user.id, id] };
    if (!Number(has.tokens) && !Number(has.refresh)) {
      await db.batch([codes]); // nothing connected: unused codes still go, as before
      fail(404, 'App not found');
    }
    // access tokens, refresh tokens, unused codes and the audit row: all or nothing
    await db.batch([
      { sql: "DELETE FROM api_tokens WHERE user_id = ? AND client_id = ? AND kind = 'oauth'", params: [user.id, id] },
      { sql: 'DELETE FROM oauth_refresh_tokens WHERE user_id = ? AND client_id = ?', params: [user.id, id] },
      codes,
      audit(user.id, 'oauth.revoked', 'oauth_client', id, { clientName: client?.client_name || null }),
    ]);
    return c.json({ ok: true });
  });

  // MCP activity log: your own calls; admins may pass ?all=1 (and ?user=<id>) to see everyone's.
  // MCP audit log. People see their own calls; admins can see everyone's (?all=1) and export CSV.
  async function mcpAudit(c) {
    sessionOnly(c);
    const db = c.env.db;
    const user = c.get('user');
    const q = c.req.query();
    const all = q.all === '1';
    if (all && user.role !== 'admin') fail(403, 'Admins only');
    const where = [];
    const params = [];
    if (!all) {
      where.push('m.user_id = ?');
      params.push(user.id);
    } else if (q.user) {
      where.push('m.user_id = ?');
      params.push(q.user);
    }
    if (q.result === 'ok') where.push('m.ok = 1');
    else if (q.result === 'error') where.push('m.ok = 0 AND m.tool IS NOT NULL');
    else if (q.result === 'rejected') where.push('m.tool IS NULL');
    if (q.write === '1') where.push('m.is_write = 1');
    if (q.tool) {
      where.push('m.tool = ?');
      params.push(String(q.tool).slice(0, 60));
    }
    if (q.project) {
      where.push('m.project_key = ?');
      params.push(String(q.project).toUpperCase().slice(0, 10));
    }
    if (q.issue) {
      where.push("(',' || COALESCE(m.issue_keys, '') || ',') LIKE ?");
      params.push(
        `%,${String(q.issue)
          .toUpperCase()
          .replace(/[^A-Z0-9-]/g, '')},%`,
      );
    }
    const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
    if (day(q.from)) {
      where.push('m.created_at >= ?');
      params.push(`${day(q.from)}T00:00:00.000Z`);
    }
    if (day(q.to)) {
      where.push('m.created_at <= ?');
      params.push(`${day(q.to)}T23:59:59.999Z`);
    }
    if (q.before) {
      where.push('m.created_at < ?');
      params.push(String(q.before));
    }
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), c.req.path.endsWith('.csv') ? 5000 : 500);
    const rows = await db.all(
      `SELECT m.*, u.name AS user_name, u.email AS user_email FROM mcp_calls m LEFT JOIN users u ON u.id = m.user_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY m.created_at DESC LIMIT ?`,
      [...params, limit],
    );
    const calls = rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      user: r.user_id ? { id: r.user_id, name: r.user_name, email: r.user_email } : null,
      tool: r.tool,
      result: r.tool === null ? 'rejected' : r.ok ? 'ok' : 'error',
      error: r.error,
      tokenPrefix: r.token_prefix,
      clientName: r.client_name,
      args: parseJson(r.args),
      issueKeys: r.issue_keys ? r.issue_keys.split(',') : [],
      projectKey: r.project_key,
      write: Boolean(Number(r.is_write)),
      durationMs: r.duration_ms,
    }));
    return { calls, more: rows.length === limit, nextBefore: rows.length === limit ? rows[rows.length - 1].created_at : null };
  }
  app.get('/api/mcp/activity', async (c) => c.json(await mcpAudit(c)));
  app.get('/api/mcp/activity.csv', async (c) => {
    const { calls } = await mcpAudit(c);
    const lines = [
      [
        'Time (UTC)',
        'Person',
        'Email',
        'App or token',
        'Token prefix',
        'Tool',
        'Changes data',
        'Result',
        'Error',
        'Project',
        'Issues',
        'Arguments',
        'Duration ms',
      ].join(','),
    ];
    for (const r of calls)
      lines.push(
        [
          r.createdAt,
          r.user?.name,
          r.user?.email,
          r.clientName,
          r.tokenPrefix,
          r.tool || '(refused credential)',
          r.write ? 'yes' : 'no',
          r.result,
          r.error,
          r.projectKey,
          r.issueKeys.join(' '),
          r.args ? JSON.stringify(r.args) : '',
          r.durationMs,
        ]
          .map(csvCell)
          .join(','),
      );
    return c.body(lines.join('\n'), 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="mcp-audit.csv"',
    });
  });
}
