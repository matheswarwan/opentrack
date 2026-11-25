// Workspace fonts (migration 0030). An admin uploads font files the workspace is licensed to
// use; they are served publicly (the sign-in page uses them too) at /api/auth/fonts/<id> and named in
// @font-face rules built by the client from /api/auth/config `fonts`. The settings fontHeading and fontBody
// hold the CSS stacks; '' keeps the default fonts (Geist).
import { body, fail } from '../lib/http.js';
import { now, uuid } from '../lib/crypto.js';
import { requireAdmin } from '../lib/session.js';
import { audit } from '../lib/audit.js';
import { toBase64, fromBase64 } from '../lib/files.js';
import { getSettings } from '../lib/settings.js';

export const FONT_MAX_BYTES = 750 * 1024;
export const FONT_MAX_FILES = 12;
const TYPES = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf' };
const FAMILY = /^[A-Za-z0-9 ._-]{1,80}$/;

/** The font format from the file's first bytes, or null. */
export function fontFormat(bytes) {
  if (!bytes || bytes.length < 4) return null;
  const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (tag === 'wOF2') return 'woff2';
  if (tag === 'wOFF') return 'woff';
  if (tag === 'OTTO') return 'otf';
  if ((bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0) || tag === 'true') return 'ttf';
  return null;
}

const out = (r) => ({
  id: r.id,
  family: r.family,
  weight: Number(r.weight),
  style: r.style,
  format: r.format,
  size: Number(r.size),
  url: `/api/auth/fonts/${r.id}`,
});

/** What the client needs: the stacks (null = brand default) and the uploaded faces. */
export async function fontConfig(db, settings) {
  const s = settings || (await getSettings(db));
  const faces = await db.all('SELECT id, family, weight, style, format, size FROM brand_fonts ORDER BY family, weight, style');
  return { heading: s.fontHeading || null, body: s.fontBody || null, faces: faces.map(out) };
}

export function registerFonts(app) {
  app.get('/api/admin/fonts', async (c) => {
    requireAdmin(c);
    return c.json(await fontConfig(c.env.db));
  });

  // { family, weight (100-900), style ('normal' | 'italic'), file: 'data:...;base64,...' }
  app.post('/api/admin/fonts', async (c) => {
    requireAdmin(c);
    const db = c.env.db;
    const b = await body(c);
    const family = String(b.family || '').trim();
    if (!FAMILY.test(family)) fail(400, 'Family must be 1 to 80 letters, digits, spaces, dots, dashes or underscores');
    const weight = Number(b.weight ?? 400);
    if (!Number.isInteger(weight) || weight < 100 || weight > 900 || weight % 100) fail(400, 'Weight must be 100, 200, ... 900');
    const style = b.style === 'italic' ? 'italic' : 'normal';
    const m = /^data:[^;,]*;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.file || ''));
    if (!m) fail(400, 'Send the font file as a base64 data URL');
    if (m[1].length > Math.ceil(FONT_MAX_BYTES / 3) * 4 + 4) fail(413, `Font files can be up to ${FONT_MAX_BYTES / 1024} KB (use WOFF2)`);
    const bytes = fromBase64(m[1]);
    if (bytes.length > FONT_MAX_BYTES) fail(413, `Font files can be up to ${FONT_MAX_BYTES / 1024} KB (use WOFF2)`);
    const format = fontFormat(bytes);
    if (!format) fail(400, 'Not a font file (WOFF2, WOFF, TTF or OTF)');
    const n = Number((await db.get('SELECT COUNT(*) AS n FROM brand_fonts')).n);
    const same = await db.get('SELECT id FROM brand_fonts WHERE family = ? AND weight = ? AND style = ?', [family, weight, style]);
    if (!same && n >= FONT_MAX_FILES) fail(400, `Up to ${FONT_MAX_FILES} font files; remove one first`);
    const id = uuid();
    const t = now();
    await db.batch([
      ...(same ? [{ sql: 'DELETE FROM brand_fonts WHERE id = ?', params: [same.id] }] : []),
      {
        sql: 'INSERT INTO brand_fonts (id, family, weight, style, format, size, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        params: [id, family, weight, style, format, bytes.length, toBase64(bytes), c.get('user').id, t],
      },
      audit(c.get('user').id, 'font.uploaded', 'font', id, { family, weight, style, format, size: bytes.length }),
    ]);
    return c.json(await fontConfig(db), 201);
  });

  app.delete('/api/admin/fonts/:id', async (c) => {
    requireAdmin(c);
    const db = c.env.db;
    const row = await db.get('SELECT id, family, weight, style FROM brand_fonts WHERE id = ?', [c.req.param('id')]);
    if (!row) fail(404, 'Font not found');
    await db.batch([
      { sql: 'DELETE FROM brand_fonts WHERE id = ?', params: [row.id] },
      audit(c.get('user').id, 'font.removed', 'font', row.id, { family: row.family, weight: Number(row.weight), style: row.style }),
    ]);
    return c.json(await fontConfig(db));
  });

  // The file. Public (GET /api/auth/* needs no session) so the sign-in page can use it; ids change on every upload.
  app.get('/api/auth/fonts/:id', async (c) => {
    const row = await c.env.db.get('SELECT format, data FROM brand_fonts WHERE id = ?', [c.req.param('id')]);
    if (!row) fail(404, 'Font not found');
    return c.body(fromBase64(row.data), 200, {
      'content-type': TYPES[row.format] || 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
      'content-security-policy': "default-src 'none'",
    });
  });
}
