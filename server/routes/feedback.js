import { body, fail, str, oneOf } from '../lib/http.js';
import { uuid, now } from '../lib/crypto.js';
import { noticeStmts } from '../lib/notifications.js';
import { requireAdmin } from '../lib/session.js';
import { avatarUrl } from '../lib/avatars.js';

export const KINDS = ['bug', 'idea', 'question', 'other'];
export const STATUSES = ['new', 'seen', 'done'];
const MAX_SCREENSHOT = 1_500_000; // characters of the data URL (D1 rows max out at 2 MB)
const PER_DAY = 20;

function out(f) {
  return {
    id: f.id,
    kind: f.kind,
    message: f.message,
    page: f.page,
    details: f.details ? JSON.parse(f.details) : null,
    hasScreenshot: Boolean(f.has_screenshot),
    status: f.status,
    adminNote: f.admin_note,
    createdAt: f.created_at,
    updatedAt: f.updated_at,
    user: f.user_id
      ? {
          id: f.user_id,
          name: f.user_name,
          email: f.user_email,
          avatarColor: f.avatar_color,
          avatarUrl: avatarUrl(f.user_id, f.avatar_version),
        }
      : null,
  };
}

const COLS = `f.id, f.kind, f.message, f.page, f.details, f.status, f.admin_note, f.created_at, f.updated_at, f.user_id,
  CASE WHEN f.screenshot IS NULL THEN 0 ELSE 1 END AS has_screenshot, u.name AS user_name, u.email AS user_email, u.avatar_color, u.avatar_version`;

export function registerFeedback(app) {
  app.post('/api/feedback', async (c) => {
    const db = c.env.db;
    const user = c.get('user');
    const b = await body(c);
    const kind = oneOf(b.kind || 'other', KINDS, 'Type');
    const message = str(b.message, { required: true, max: 10000, name: 'Message' });
    const page = str(b.page, { max: 300, name: 'Page' }) || null;
    let details = null;
    if (b.details !== undefined && b.details !== null) {
      if (typeof b.details !== 'object') fail(400, 'details must be an object');
      details = JSON.stringify(b.details);
      if (details.length > 20000) fail(400, 'Technical details are too long');
    }
    let screenshot = null;
    if (b.screenshot) {
      if (typeof b.screenshot !== 'string' || !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(b.screenshot))
        fail(400, 'Screenshot must be a PNG, JPEG, WebP or GIF image');
      if (b.screenshot.length > MAX_SCREENSHOT) fail(400, 'Screenshot is too large (about 1 MB at most)');
      screenshot = b.screenshot;
    }
    const since = new Date(Date.now() - 864e5).toISOString();
    const recent = await db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM feedback WHERE user_id = ? AND created_at > ?', [
      user.id,
      since,
    ]);
    if (recent.n >= PER_DAY) fail(429, `You have sent ${PER_DAY} pieces of feedback today. Try again tomorrow.`);
    const id = uuid();
    const t = now();
    const admins = await db.all(`SELECT id FROM users WHERE role = 'admin' AND status = 'active' AND id <> ?`, [user.id]);
    const preview = message.length > 80 ? `${message.slice(0, 80)}…` : message;
    await db.batch([
      {
        sql: 'INSERT INTO feedback (id, user_id, kind, message, page, details, screenshot, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        params: [id, user.id, kind, message, page, details, screenshot, 'new', t, t],
      },
      ...noticeStmts(
        admins.map((a) => ({
          userId: a.id,
          type: 'feedback',
          actorId: user.id,
          message: `${user.name} sent feedback (${kind}): ${preview}`,
          at: t,
        })),
      ),
    ]);
    return c.json({ id }, 201);
  });

  // The sender's own feedback and what happened to it.
  app.get('/api/feedback/mine', async (c) => {
    const rows = await c.env.db.all(
      `SELECT ${COLS} FROM feedback f LEFT JOIN users u ON u.id = f.user_id WHERE f.user_id = ? ORDER BY f.created_at DESC LIMIT 50`,
      [c.get('user').id],
    );
    return c.json({ feedback: rows.map(out) });
  });

  app.get('/api/admin/feedback', async (c) => {
    requireAdmin(c);
    const status = c.req.query('status');
    const where = status ? 'WHERE f.status = ?' : '';
    const rows = await c.env.db.all(
      `SELECT ${COLS} FROM feedback f LEFT JOIN users u ON u.id = f.user_id ${where} ORDER BY f.created_at DESC LIMIT 500`,
      status ? [oneOf(status, STATUSES, 'status')] : [],
    );
    const counts = await c.env.db.all('SELECT status, CAST(COUNT(*) AS INTEGER) AS n FROM feedback GROUP BY status');
    return c.json({ feedback: rows.map(out), counts: Object.fromEntries(counts.map((r) => [r.status, r.n])) });
  });

  app.get('/api/admin/feedback/:id/screenshot', async (c) => {
    requireAdmin(c);
    const row = await c.env.db.get('SELECT screenshot FROM feedback WHERE id = ?', [c.req.param('id')]);
    if (!row?.screenshot) fail(404, 'No screenshot');
    const [, type, data] = row.screenshot.match(/^data:(image\/[a-z]+);base64,(.*)$/);
    const bin = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
    return c.body(bin, 200, {
      'content-type': type,
      'content-security-policy': "default-src 'none'",
      'cache-control': 'private, max-age=3600',
    });
  });

  app.patch('/api/admin/feedback/:id', async (c) => {
    requireAdmin(c);
    const b = await body(c);
    const status = oneOf(b.status, STATUSES, 'Status');
    const note = str(b.note, { max: 2000, name: 'Note' });
    const row = await c.env.db.get('SELECT status, admin_note FROM feedback WHERE id = ?', [c.req.param('id')]);
    if (!row) fail(404, 'Feedback not found');
    await c.env.db.run('UPDATE feedback SET status = ?, admin_note = ?, updated_at = ? WHERE id = ?', [
      status ?? row.status,
      note === undefined ? row.admin_note : note || null,
      now(),
      c.req.param('id'),
    ]);
    return c.json({ ok: true });
  });
}
