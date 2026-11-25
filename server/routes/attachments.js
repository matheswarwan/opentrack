// Issue attachments: upload, download, delete. Bytes live in server/lib/files.js stores.
import { fail } from '../lib/http.js';
import { uuid, now } from '../lib/crypto.js';
import { historyStmt, changeSource } from '../lib/history.js';
import { projectAccess, issueRights } from '../lib/access.js';
import { fileStore, defaultStorage, MAX_SIZE } from '../lib/files.js';

export const MAX_FILES_PER_ISSUE = 50;

// Shown in the browser (Content-Disposition: inline). Everything else is a download.
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);
// Stored, but always served as application/octet-stream downloads.
const DANGEROUS_EXT = new Set([
  'html',
  'htm',
  'xhtml',
  'shtml',
  'mht',
  'mhtml',
  'svg',
  'svgz',
  'xml',
  'xsl',
  'xslt',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'wasm',
  'exe',
  'dll',
  'msi',
  'bat',
  'cmd',
  'com',
  'scr',
  'pif',
  'cpl',
  'hta',
  'vbs',
  'vbe',
  'jse',
  'wsf',
  'wsh',
  'ps1',
  'psm1',
  'sh',
  'jar',
  'apk',
  'app',
  'dmg',
  'pkg',
  'deb',
  'rpm',
  'lnk',
  'reg',
  'swf',
  'php',
  'jsp',
  'asp',
  'aspx',
  'cgi',
  'pl',
  'py',
]);
const DANGEROUS_TYPE = /(html|svg|xml|javascript|ecmascript|x-msdownload|x-msdos|x-sh|x-csh|java-archive|x-shockwave|x-httpd|wasm)/i;

const ext = (name) => (/\.([^.]+)$/.exec(name)?.[1] || '').toLowerCase();

export function isDangerous(filename, contentType) {
  return DANGEROUS_EXT.has(ext(filename)) || DANGEROUS_TYPE.test(contentType || '');
}

export function cleanFilename(name) {
  const base = String(name || '')
    .split(/[\\/]/)
    .pop()
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is being removed
    .replace(/[\u0000-\u001f\u007f"]/g, '')
    .trim();
  return (base || 'file').slice(-200);
}

export function cleanType(t) {
  const v = String(t || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return /^[a-z0-9][\w.+-]*\/[\w.+-]+$/.test(v) ? v : 'application/octet-stream';
}

const attachmentUrl = (id) => `/api/attachments/${id}`;

export function attachmentOut(a, userId) {
  return {
    id: a.id,
    filename: a.filename,
    contentType: a.content_type,
    size: a.size,
    url: attachmentUrl(a.id),
    commentId: a.comment_id || null,
    internal: Boolean(Number(a.internal)),
    uploadedBy: a.uploaded_by ? { id: a.uploaded_by, name: a.uploader_name } : null,
    createdAt: a.created_at,
    mine: a.uploaded_by === userId,
  };
}

export const ATTACHMENT_SELECT = `SELECT a.*, u.name AS uploader_name FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by`;

async function issueFor(c, key, need) {
  const db = c.env.db;
  const row = await db.get('SELECT id, key, project_id, reporter_id FROM issues WHERE (key = ? OR id = ?) AND deleted_at IS NULL', [
    String(key).toUpperCase(),
    key,
  ]);
  if (!row) fail(404, 'Issue not found');
  const access = await projectAccess(c, row.project_id, need);
  return { row, access, db };
}

/** Read the upload: multipart field `file`, or the raw body with ?filename=. */
async function readUpload(c, max) {
  const len = Number(c.req.header('content-length') || 0);
  if (len > max + 64 * 1024) fail(413, `Files can be at most ${max / 1024 / 1024} MB`);
  const type = c.req.header('content-type') || '';
  let filename, contentType, bytes;
  if (type.startsWith('multipart/form-data')) {
    let form;
    try {
      form = await c.req.formData();
    } catch {
      fail(400, 'Could not read the upload');
    }
    const file = form.get('file');
    if (!file || typeof file === 'string') fail(400, 'Send the file in a form field named file');
    filename = file.name;
    contentType = file.type;
    bytes = new Uint8Array(await file.arrayBuffer());
  } else {
    filename = c.req.query('filename');
    if (!filename) fail(400, 'Add ?filename= or send multipart/form-data');
    contentType = type;
    bytes = new Uint8Array(await c.req.arrayBuffer());
  }
  if (!bytes.length) fail(400, 'The file is empty');
  if (bytes.length > max) fail(413, `Files can be at most ${max / 1024 / 1024} MB`);
  return { filename: cleanFilename(filename), contentType: cleanType(contentType), bytes };
}

function contentDisposition(kind, filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function registerAttachments(app) {
  app.post('/api/issues/:key/attachments', async (c) => {
    const { row, access, db } = await issueFor(c, c.req.param('key'), 'view');
    const user = c.get('user');
    // Anyone who can edit the issue, or comment on it (files added to a comment), may upload.
    const rights = issueRights(access, user, row);
    if (!rights.canEdit && !rights.canComment)
      fail(403, access.project.archived ? 'This project is archived' : 'You cannot add files to this issue');
    // ?internal=1: a file for an internal note, hidden from guests (team members only)
    const internal = c.req.query('internal') === '1';
    if (internal && access.guest) fail(403, 'Guests cannot add internal notes');
    const count = await db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM attachments WHERE issue_id = ?', [row.id]);
    if (count.n >= MAX_FILES_PER_ISSUE) fail(400, `An issue can have at most ${MAX_FILES_PER_ISSUE} attachments`);
    const storage = defaultStorage(c.env);
    const store = fileStore(c.env, storage);
    const { filename, contentType, bytes } = await readUpload(c, MAX_SIZE[storage]);
    const id = uuid();
    const t = now();
    // The row first (file_chunks references it), then the bytes; undo the row if storing fails.
    await db.run(
      'INSERT INTO attachments (id, issue_id, comment_id, filename, content_type, size, storage, uploaded_by, created_at, internal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, row.id, null, filename, contentType, bytes.length, storage, user.id, t, internal ? 1 : 0],
    );
    try {
      await store.put(id, bytes, contentType);
    } catch (e) {
      await db.run('DELETE FROM attachments WHERE id = ?', [id]);
      console.error('attachment store failed', e?.message);
      fail(500, 'Could not store the file');
    }
    await db.batch([
      historyStmt(row.id, user.id, internal ? 'internal_attachment' : 'attachment', null, filename, t, changeSource(c)), // internal_*: hidden from guests
      { sql: 'UPDATE issues SET updated_at = ? WHERE id = ?', params: [t, row.id] },
    ]);
    const a = await db.get(`${ATTACHMENT_SELECT} WHERE a.id = ?`, [id]);
    return c.json({ attachment: attachmentOut(a, user.id) }, 201);
  });

  app.get('/api/attachments/:id', async (c) => {
    const db = c.env.db;
    const a = await db.get(
      `SELECT a.*, i.project_id FROM attachments a JOIN issues i ON i.id = a.issue_id WHERE a.id = ? AND i.deleted_at IS NULL`,
      [c.req.param('id')],
    );
    if (!a) fail(404, 'Attachment not found');
    const access = await projectAccess(c, a.project_id, 'view'); // 404 when not visible or outside a token's scope
    if (Number(a.internal) && access.guest) fail(404, 'Attachment not found'); // internal-note files are never served to guests
    const store = fileStore(c.env, a.storage);
    const bytes = store && (await store.get(a.id));
    if (!bytes) fail(404, 'The file is missing');
    const dangerous = isDangerous(a.filename, a.content_type);
    const inline = !dangerous && INLINE_TYPES.has(a.content_type);
    return c.body(bytes, 200, {
      'content-type': dangerous ? 'application/octet-stream' : a.content_type,
      'content-length': String(bytes.length),
      'content-disposition': contentDisposition(inline ? 'inline' : 'attachment', a.filename),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
      'cache-control': 'private, max-age=3600',
    });
  });

  app.delete('/api/attachments/:id', async (c) => {
    const db = c.env.db;
    const a = await db.get(
      'SELECT a.id, a.issue_id, a.filename, a.storage, a.uploaded_by, a.internal, i.project_id FROM attachments a JOIN issues i ON i.id = a.issue_id WHERE a.id = ? AND i.deleted_at IS NULL',
      [c.req.param('id')],
    );
    if (!a) fail(404, 'Attachment not found');
    const user = c.get('user');
    const access = await projectAccess(c, a.project_id, 'view');
    if (Number(a.internal) && access.guest) fail(404, 'Attachment not found');
    if (!access.canAdmin && !(access.canEdit && a.uploaded_by === user.id))
      fail(403, 'Only the person who added the file or a project admin can delete it');
    const t = now();
    await db.batch([
      { sql: 'DELETE FROM attachments WHERE id = ?', params: [a.id] }, // chunks cascade
      historyStmt(a.issue_id, user.id, Number(a.internal) ? 'internal_attachment' : 'attachment', a.filename, null, t, changeSource(c)),
      { sql: 'UPDATE issues SET updated_at = ? WHERE id = ?', params: [t, a.issue_id] },
    ]);
    if (a.storage !== 'db') {
      try {
        await fileStore(c.env, a.storage)?.delete(a.id);
      } catch (e) {
        console.error('attachment delete failed', a.id, e?.message);
      }
    }
    return c.json({ ok: true });
  });
}
