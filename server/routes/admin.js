import { body, fail, str, oneOf, EMAIL_RE } from '../lib/http.js';
import { uuid, now, randomToken, sha256, hashPassword, avatarColor } from '../lib/crypto.js';
import { requireAdmin } from '../lib/session.js';
import { audit } from '../lib/audit.js';
import {
  getSettings,
  settingStatements,
  DEFAULT_SETTINGS,
  FONT_STACK,
  cleanDomains,
  domainAllowed,
  domainMessage,
} from '../lib/settings.js';
import { validTimeZone } from '../lib/time.js';
import { checkPassword } from './auth.js';
import { publicOrigin } from '../lib/http.js';
import { avatarUrl } from '../lib/avatars.js';
import { emailConfigured, MAX_RECIPIENTS } from '../lib/email.js';
import { emailInviteLink } from './email.js';
import { csvCell } from '../lib/csv.js';

const ROLES = ['admin', 'member', 'viewer', 'guest'];
const INVITE_DAYS = 7;

function userOut(u, settings) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    title: u.title,
    role: u.role,
    status: u.status,
    avatarColor: u.avatar_color,
    avatarUrl: avatarUrl(u.id, u.avatar_version),
    hasPassword: Boolean(u.has_password),
    google: Boolean(u.has_google),
    twoFactor: Boolean(u.totp_enabled_at),
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
    // the email is outside Admin > Settings > Allowed email domains (the account keeps working)
    outsideDomains: settings ? !domainAllowed(settings, u.email) : false,
  };
}

async function inviteStatements(c, userId) {
  const token = randomToken();
  const expires = new Date(Date.now() + INVITE_DAYS * 864e5).toISOString();
  return {
    link: `${publicOrigin(c)}/invite/${token}`,
    expiresAt: expires,
    stmts: [
      { sql: 'DELETE FROM invites WHERE user_id = ? AND used_at IS NULL', params: [userId] },
      {
        sql: 'INSERT INTO invites (token_hash, user_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
        params: [await sha256(token), userId, c.get('user').id, now(), expires],
      },
    ],
  };
}

/** Validate one new-user row; returns the clean row or throws. */
function cleanNewUser(b) {
  const email = str(b.email, { required: true, max: 200, name: 'Email' }).toLowerCase();
  if (!EMAIL_RE.test(email)) fail(400, `Email is not valid: ${email}`);
  const name = str(b.name, { max: 100, name: 'Name' }) || email.split('@')[0];
  const role = oneOf(b.role || 'member', ROLES, 'Role');
  const title = str(b.title, { max: 100, name: 'Title' }) || null;
  if (b.password !== undefined && b.password !== '') checkPassword(b.password);
  return { email, name, role, title, password: b.password || null };
}

async function createUser(c, row, settings) {
  const db = c.env.db;
  if (!domainAllowed(settings, row.email)) fail(400, domainMessage(settings, row.email));
  if (await db.get('SELECT id FROM users WHERE email = ?', [row.email])) fail(409, `A user with ${row.email} already exists`);
  const id = uuid();
  const actor = c.get('user').id;
  const status = row.password ? 'active' : 'invited';
  const stmts = [
    {
      sql: `INSERT INTO users (id, email, name, title, role, status, password_hash, avatar_color, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        id,
        row.email,
        row.name,
        row.title,
        row.role,
        status,
        row.password ? await hashPassword(row.password) : null,
        avatarColor(row.email),
        now(),
        now(),
      ],
    },
    audit(actor, 'user.created', 'user', id, { email: row.email, role: row.role, withPassword: Boolean(row.password) }),
  ];
  let invite = null;
  if (!row.password) {
    invite = await inviteStatements(c, id);
    stmts.push(...invite.stmts);
  }
  await db.batch(stmts);
  return {
    id,
    email: row.email,
    name: row.name,
    role: row.role,
    status,
    inviteLink: invite?.link || null,
    inviteExpiresAt: invite?.expiresAt || null,
  };
}

const USER_COLS = `id, email, name, title, role, status, avatar_color, avatar_version, created_at, last_login_at, totp_enabled_at,
  CASE WHEN password_hash IS NULL THEN 0 ELSE 1 END AS has_password,
  CASE WHEN google_sub IS NULL THEN 0 ELSE 1 END AS has_google`;

export function registerAdmin(app) {
  app.get('/api/admin/users', async (c) => {
    requireAdmin(c);
    const [rows, settings] = await Promise.all([
      c.env.db.all(`SELECT ${USER_COLS} FROM users WHERE is_system = 0 ORDER BY LOWER(name)`),
      getSettings(c.env.db),
    ]);
    return c.json({
      users: rows.map((u) => userOut(u, settings)),
      emailConfigured: emailConfigured(c.env),
      allowedDomains: settings.allowedDomains,
    });
  });

  // Manual account creation. Without a password the user gets an invite link (valid 7 days)
  // to set their own; with a password the account is active at once.
  app.post('/api/admin/users', async (c) => {
    requireAdmin(c);
    const b = await body(c);
    const row = cleanNewUser(b);
    const user = await createUser(c, row, await getSettings(c.env.db));
    // optional: email the invite link too (b.sendEmail)
    if (b.sendEmail && user.inviteLink && emailConfigured(c.env))
      Object.assign(user, await emailInviteLink(c, user, { link: user.inviteLink, expiresAt: user.inviteExpiresAt }, false));
    return c.json({ user }, 201);
  });

  // Bulk create: { users: [{ email, name, role, title }] } (from a CSV the UI parses).
  app.post('/api/admin/users/bulk', async (c) => {
    requireAdmin(c);
    const b = await body(c);
    if (!Array.isArray(b.users) || !b.users.length) fail(400, 'users must be a non-empty list');
    if (b.users.length > 500) fail(400, 'At most 500 users at a time');
    const results = [];
    const settings = await getSettings(c.env.db);
    let emails = 0; // b.sendEmail: email invite links, at most MAX_RECIPIENTS per request
    for (const raw of b.users) {
      try {
        const row = cleanNewUser({ ...raw, password: undefined });
        const user = await createUser(c, row, settings);
        if (b.sendEmail && emailConfigured(c.env)) {
          if (emails++ < MAX_RECIPIENTS)
            Object.assign(user, await emailInviteLink(c, user, { link: user.inviteLink, expiresAt: user.inviteExpiresAt }, false));
          else
            Object.assign(user, {
              emailed: false,
              emailError: `Not emailed: at most ${MAX_RECIPIENTS} emails at a time. Copy the link or use New invite link.`,
            });
        }
        results.push({ ok: true, user });
      } catch (e) {
        results.push({ ok: false, email: raw?.email || '', error: e.message });
      }
    }
    return c.json({ results });
  });

  app.patch('/api/admin/users/:id', async (c) => {
    requireAdmin(c);
    const db = c.env.db;
    const id = c.req.param('id');
    const b = await body(c);
    const user = await db.get(`SELECT ${USER_COLS} FROM users WHERE id = ? AND is_system = 0`, [id]);
    if (!user) fail(404, 'User not found');
    const name = str(b.name, { max: 100, name: 'Name' });
    const title = str(b.title, { max: 100, name: 'Title' });
    const role = oneOf(b.role, ROLES, 'Role');
    const status = oneOf(b.status, ['active', 'deactivated'], 'Status');
    if (status === 'active' && user.status === 'invited') fail(400, 'Invited users become active when they accept their invite');
    const losingAdmin = user.role === 'admin' && user.status === 'active' && ((role && role !== 'admin') || status === 'deactivated');
    if (losingAdmin) {
      const admins = await db.get(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM users WHERE role = 'admin' AND status = 'active'`);
      if (admins.n <= 1) fail(400, 'There must be at least one active admin');
    }
    const sets = [];
    const params = [];
    const changes = {};
    for (const [col, v] of [
      ['name', name],
      ['title', title],
      ['role', role],
      ['status', status],
    ]) {
      if (v === undefined || v === user[col]) continue;
      if (col === 'name' && !v) fail(400, 'Name is required');
      sets.push(`${col} = ?`);
      params.push(v);
      changes[col] = { from: user[col], to: v };
    }
    if (sets.length) {
      const stmts = [
        { sql: `UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, params: [...params, now(), id] },
        audit(c.get('user').id, 'user.updated', 'user', id, changes),
      ];
      // Becoming or leaving guest: project roles move between the guest levels and the normal ones.
      if (changes.role && (changes.role.from === 'guest') !== (changes.role.to === 'guest')) {
        const toGuest = changes.role.to === 'guest';
        const map = toGuest
          ? [
              ['admin', 'guest-edit'],
              ['member', 'guest-edit'],
              ['viewer', 'guest-view'],
            ]
          : [
              ['guest-edit', 'member'],
              ['guest-comment', 'viewer'],
              ['guest-view', 'viewer'],
            ];
        for (const [from, to] of map)
          stmts.push({ sql: 'UPDATE project_members SET role = ? WHERE user_id = ? AND role = ?', params: [to, id, from] });
        // a guest has no API tokens or connected AI apps
        if (toGuest) {
          stmts.push({ sql: 'UPDATE api_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', params: [now(), id] });
          stmts.push({ sql: 'DELETE FROM oauth_refresh_tokens WHERE user_id = ?', params: [id] });
        }
      }
      if (status === 'deactivated') {
        stmts.push({ sql: 'DELETE FROM sessions WHERE user_id = ?', params: [id] });
        stmts.push({ sql: 'DELETE FROM invites WHERE user_id = ? AND used_at IS NULL', params: [id] });
      }
      await db.batch(stmts);
    }
    const out = await db.get(`SELECT ${USER_COLS} FROM users WHERE id = ?`, [id]);
    return c.json({ user: userOut(out, await getSettings(db)) });
  });

  // New invite / password reset link. Old unused links stop working.
  app.post('/api/admin/users/:id/invite', async (c) => {
    requireAdmin(c);
    const db = c.env.db;
    const b = await body(c);
    const user = await db.get('SELECT id, email, name, status FROM users WHERE id = ? AND is_system = 0', [c.req.param('id')]);
    if (!user) fail(404, 'User not found');
    if (user.status === 'deactivated') fail(400, 'Reactivate the user first');
    if (user.status === 'invited') {
      // a new invite is refused outside the allowed domains; a reset link for an active user is not
      const settings = await getSettings(db);
      if (!domainAllowed(settings, user.email)) fail(400, domainMessage(settings, user.email));
    }
    const invite = await inviteStatements(c, user.id);
    await db.batch([...invite.stmts, audit(c.get('user').id, 'user.link_created', 'user', user.id)]);
    // optional: email the link too (b.sendEmail)
    const mail = b.sendEmail && emailConfigured(c.env) ? await emailInviteLink(c, user, invite, user.status === 'active') : {};
    return c.json({ link: invite.link, expiresAt: invite.expiresAt, ...mail });
  });

  // Set a password for someone directly (e.g. when they cannot receive a link).
  app.post('/api/admin/users/:id/password', async (c) => {
    requireAdmin(c);
    const db = c.env.db;
    const b = await body(c);
    checkPassword(b.password);
    const user = await db.get('SELECT id, status FROM users WHERE id = ? AND is_system = 0', [c.req.param('id')]);
    if (!user) fail(404, 'User not found');
    if (user.status === 'deactivated') fail(400, 'Reactivate the user first');
    await db.batch([
      {
        sql: `UPDATE users SET password_hash = ?, status = 'active', updated_at = ? WHERE id = ?`,
        params: [await hashPassword(b.password), now(), user.id],
      },
      { sql: 'DELETE FROM sessions WHERE user_id = ?', params: [user.id] },
      { sql: 'UPDATE invites SET used_at = ? WHERE user_id = ? AND used_at IS NULL', params: [now(), user.id] },
      audit(c.get('user').id, 'user.password_set', 'user', user.id),
    ]);
    return c.json({ ok: true });
  });

  app.get('/api/admin/settings', async (c) => {
    requireAdmin(c);
    return c.json({
      settings: await getSettings(c.env.db),
      googleConfigured: Boolean(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET),
    });
  });

  app.patch('/api/admin/settings', async (c) => {
    requireAdmin(c);
    const b = await body(c);
    const patch = {};
    for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) {
      if (b[k] === undefined) continue;
      if (k === 'allowedDomains') {
        try {
          patch[k] = cleanDomains(b[k]);
        } catch (e) {
          fail(400, e.message);
        }
        continue;
      }
      if (typeof b[k] !== typeof def) fail(400, `${k} has the wrong type`);
      if (k === 'idleTimeoutMinutes' && (!Number.isInteger(b[k]) || (b[k] !== 0 && (b[k] < 15 || b[k] > 10080))))
        fail(400, 'idleTimeoutMinutes must be 0 (off) or a whole number from 15 to 10080');
      if (k === 'projectCreation') oneOf(b[k], ['everyone', 'admins'], k);
      if (k === 'timeZone' && !validTimeZone(b[k].trim())) fail(400, 'timeZone must be a time zone name such as America/Vancouver');
      if (typeof b[k] === 'string' && b[k].length > 500) fail(400, `${k} is too long`);
      if (k === 'mcpLogDays' && (!Number.isInteger(b[k]) || b[k] < 7 || b[k] > 730))
        fail(400, 'mcpLogDays must be a whole number from 7 to 730');
      if (k === 'defaultCapacityHours' && (b[k] < 0 || b[k] > 100)) fail(400, 'defaultCapacityHours must be a number from 0 to 100');
      if ((k === 'fontHeading' || k === 'fontBody') && !FONT_STACK.test(b[k].trim()))
        fail(400, `${k} must be a list of font names separated by commas (letters, digits, spaces, quotes, dots, dashes)`);
      if (k === 'trashDays' && (!Number.isInteger(b[k]) || b[k] < 1 || b[k] > 365))
        fail(400, 'trashDays must be a whole number from 1 to 365');
      patch[k] = typeof b[k] === 'string' ? b[k].trim() : b[k];
    }
    if (patch.appName === '') fail(400, 'appName is required');
    await c.env.db.batch([...settingStatements(patch), audit(c.get('user').id, 'settings.updated', 'settings', null, patch)]);
    return c.json({ settings: await getSettings(c.env.db) });
  });

  // Audit log with filters: source (admin | ai), actor (user id), action
  // (text in the action name), q (text in target or details), from/to (dates), before (paging).
  async function auditEntries(c, max) {
    requireAdmin(c);
    const q = c.req.query();
    const limit = Math.min(Number(q.limit) || 100, max);
    const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
    const where = (alias, actorCol) => {
      const w = [];
      const p = [];
      if (q.actor) {
        w.push(`${actorCol} = ?`);
        p.push(String(q.actor));
      }
      if (day(q.from)) {
        w.push(`${alias}.created_at >= ?`);
        p.push(`${day(q.from)}T00:00:00.000Z`);
      }
      if (day(q.to)) {
        w.push(`${alias}.created_at <= ?`);
        p.push(`${day(q.to)}T23:59:59.999Z`);
      }
      if (q.before) {
        w.push(`${alias}.created_at < ?`);
        p.push(String(q.before));
      }
      return { w, p };
    };
    const like = (v) => `%${String(v).toLowerCase().replace(/[%_]/g, '')}%`;
    const wantAdmin = q.source !== 'ai';
    const wantAi = q.source !== 'admin';
    const a = where('a', 'a.actor_id');
    if (q.action) {
      a.w.push('lower(a.action) LIKE ?');
      a.p.push(like(q.action));
    }
    if (q.q) {
      a.w.push("(lower(COALESCE(a.details, '')) LIKE ? OR lower(COALESCE(t.name, '')) LIKE ? OR lower(COALESCE(t.email, '')) LIKE ?)");
      a.p.push(like(q.q), like(q.q), like(q.q));
    }
    const rows = wantAdmin
      ? await c.env.db.all(
          `SELECT a.id, a.action, a.target_type, a.target_id, a.details, a.created_at, u.name AS actor_name,
                t.name AS target_name, t.email AS target_email
           FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
           LEFT JOIN users t ON a.target_type = 'user' AND t.id = a.target_id
          ${a.w.length ? `WHERE ${a.w.join(' AND ')}` : ''}
          ORDER BY a.created_at DESC LIMIT ?`,
          [...a.p, limit],
        )
      : [];
    // AI assistant (MCP) calls that changed something or were refused also belong in the
    // audit log; every call, reads too, stays in Admin > AI audit (MCP).
    const m = where('m', 'm.user_id');
    m.w.unshift('(m.is_write = 1 OR m.tool IS NULL)');
    if (q.action) {
      m.w.push("lower('ai.' || COALESCE(m.tool, 'rejected')) LIKE ?");
      m.p.push(like(q.action));
    }
    if (q.q) {
      m.w.push(
        "(lower(COALESCE(m.issue_keys, '')) LIKE ? OR lower(COALESCE(m.project_key, '')) LIKE ? OR lower(COALESCE(m.client_name, '')) LIKE ? OR lower(COALESCE(m.error, '')) LIKE ?)",
      );
      m.p.push(like(q.q), like(q.q), like(q.q), like(q.q));
    }
    const mcp = wantAi
      ? await c.env.db.all(
          `SELECT m.id, m.tool, m.ok, m.error, m.client_name, m.token_prefix, m.issue_keys, m.project_key, m.created_at, u.name AS actor_name
           FROM mcp_calls m LEFT JOIN users u ON u.id = m.user_id
          WHERE ${m.w.join(' AND ')}
          ORDER BY m.created_at DESC LIMIT ?`,
          [...m.p, limit],
        )
      : [];
    const entries = [
      ...rows.map((r) => ({
        id: r.id,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        targetName: r.target_name || r.target_email || null,
        details: r.details ? JSON.parse(r.details) : null,
        actorName: r.actor_name,
        createdAt: r.created_at,
      })),
      ...mcp.map((x) => {
        const details = {
          app: x.client_name || (x.token_prefix ? `token ${x.token_prefix}...` : 'unknown'),
          result: x.tool === null ? 'rejected' : x.ok ? 'ok' : 'error',
        };
        if (x.error) details.error = String(x.error).slice(0, 200);
        return {
          id: `mcp-${x.id}`,
          action: x.tool ? `ai.${x.tool}` : 'ai.rejected',
          targetType: x.issue_keys ? 'issue' : x.project_key ? 'project' : null,
          targetId: null,
          targetName: x.issue_keys ? x.issue_keys.split(',').join(', ') : x.project_key || null,
          details,
          actorName: x.actor_name,
          source: 'mcp',
          createdAt: x.created_at,
        };
      }),
    ]
      .sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1))
      .slice(0, limit);
    const more = rows.length === limit || mcp.length === limit;
    return { entries, more, nextBefore: more && entries.length ? entries[entries.length - 1].createdAt : null };
  }

  app.get('/api/admin/audit', async (c) => c.json(await auditEntries(c, 500)));
  app.get('/api/admin/audit.csv', async (c) => {
    const { entries } = await auditEntries(c, 5000);
    const describe = (d) =>
      d
        ? Object.entries(d)
            .map(([k, v]) => `${k}: ${typeof v === 'object' && v ? `${v.from ?? ''} -> ${v.to ?? ''}` : v}`)
            .join('; ')
        : '';
    const lines = [
      ['When', 'Who', 'Action', 'Target', 'Details', 'Source'].join(','),
      ...entries.map((e) =>
        [
          e.createdAt,
          e.actorName || 'System',
          e.action,
          e.targetName || '',
          describe(e.details),
          e.source === 'mcp' ? 'AI assistant' : 'Admin',
        ]
          .map(csvCell)
          .join(','),
      ),
    ];
    return new Response(`${lines.join('\n')}\n`, {
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="audit-log.csv"' },
    });
  });
}
