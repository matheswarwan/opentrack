import { body, fail } from '../lib/http.js';
import { now, randomToken } from '../lib/crypto.js';
import { requireAdmin } from '../lib/session.js';
import { audit } from '../lib/audit.js';
import { avatarUrl, checkAvatar, decodeAvatar } from '../lib/avatars.js';

async function setAvatar(db, userId, image) {
  const version = randomToken(8);
  const t = now();
  await db.batch([
    { sql: 'DELETE FROM user_avatars WHERE user_id = ?', params: [userId] },
    { sql: 'INSERT INTO user_avatars (user_id, image, updated_at) VALUES (?, ?, ?)', params: [userId, image, t] },
    { sql: 'UPDATE users SET avatar_version = ?, updated_at = ? WHERE id = ?', params: [version, t, userId] },
  ]);
  return version;
}

function removeStatements(userId) {
  return [
    { sql: 'DELETE FROM user_avatars WHERE user_id = ?', params: [userId] },
    { sql: 'UPDATE users SET avatar_version = NULL, updated_at = ? WHERE id = ?', params: [now(), userId] },
  ];
}

export function registerAvatars(app) {
  // Upload or replace your own photo: { image: 'data:image/jpeg;base64,...' }.
  app.put('/api/me/avatar', async (c) => {
    const b = await body(c);
    const check = checkAvatar(b.image);
    if (check.error) fail(400, check.error);
    const user = c.get('user');
    const version = await setAvatar(c.env.db, user.id, b.image);
    return c.json({ avatarUrl: avatarUrl(user.id, version) });
  });

  app.delete('/api/me/avatar', async (c) => {
    await c.env.db.batch(removeStatements(c.get('user').id));
    return c.json({ avatarUrl: null });
  });

  // Moderation: an admin removes someone's photo.
  app.delete('/api/admin/users/:id/avatar', async (c) => {
    requireAdmin(c);
    const db = c.env.db;
    const user = await db.get('SELECT id FROM users WHERE id = ?', [c.req.param('id')]);
    if (!user) fail(404, 'User not found');
    await db.batch([...removeStatements(user.id), audit(c.get('user').id, 'user.avatar_removed', 'user', user.id)]);
    return c.json({ ok: true });
  });

  // The photo itself. Only for signed-in users (the /api/* guard runs first).
  app.get('/api/users/:id/avatar', async (c) => {
    const row = await c.env.db.get('SELECT image FROM user_avatars WHERE user_id = ?', [c.req.param('id')]);
    const img = row && decodeAvatar(row.image);
    if (!img) fail(404, 'No photo');
    return c.body(img.bytes, 200, {
      'content-type': img.type,
      'cache-control': 'private, max-age=86400',
      'content-security-policy': "default-src 'none'",
    });
  });
}
