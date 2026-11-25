// File storage for attachments. Every store has put(id, bytes, contentType), get(id) -> Uint8Array | null
// and delete(id). The backend comes from env:
//   env.FILES       a Cloudflare R2 bucket binding                       -> 'r2'
//   env.GCS_BUCKET  a Google Cloud Storage bucket (Cloud Run)            -> 'gcs'
//   otherwise       the database itself, table file_chunks               -> 'db'
// Each attachment row records its storage, so files keep working if the default changes later.
import { b64url } from './crypto.js';

const MB = 1024 * 1024;
export const MAX_SIZE = { db: 10 * MB, r2: 25 * MB, gcs: 25 * MB };
const CHUNK = 768 * 1024; // raw bytes per row; about 1 MB as base64

export function defaultStorage(env) {
  if (env.FILES) return 'r2';
  if (env.GCS_BUCKET) return 'gcs';
  return 'db';
}

/** The store for `kind` ('db', 'r2' or 'gcs'), or null when this host has no such backend. */
export function fileStore(env, kind = defaultStorage(env)) {
  if (kind === 'db') return dbStore(env.db);
  if (kind === 'r2') return env.FILES ? r2Store(env.FILES) : null;
  if (kind === 'gcs') return env.GCS_BUCKET ? gcsStore(env) : null;
  return null;
}

export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- database (default) ----
// file_chunks.file_id references attachments(id), so the attachment row must exist before put().
function dbStore(db) {
  return {
    kind: 'db',
    async put(id, bytes) {
      // One statement per chunk: keeps every request well under D1's size limits.
      for (let seq = 0, off = 0; off < bytes.length || seq === 0; seq++, off += CHUNK) {
        await db.run('INSERT INTO file_chunks (file_id, seq, data) VALUES (?, ?, ?)', [
          id,
          seq,
          toBase64(bytes.subarray(off, off + CHUNK)),
        ]);
      }
    },
    async get(id) {
      const rows = await db.all('SELECT data FROM file_chunks WHERE file_id = ? ORDER BY seq', [id]);
      if (!rows.length) return null;
      const parts = rows.map((r) => fromBase64(r.data));
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let off = 0;
      for (const p of parts) {
        out.set(p, off);
        off += p.length;
      }
      return out;
    },
    async delete(id) {
      await db.run('DELETE FROM file_chunks WHERE file_id = ?', [id]);
    },
  };
}

// ---- Cloudflare R2 (not enabled on the account yet: untested) ----
function r2Store(bucket) {
  const key = (id) => `attachments/${id}`;
  return {
    kind: 'r2',
    async put(id, bytes, contentType) {
      await bucket.put(key(id), bytes, { httpMetadata: { contentType } });
    },
    async get(id) {
      const obj = await bucket.get(key(id));
      return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
    },
    async delete(id) {
      await bucket.delete(key(id));
    },
  };
}

// ---- Google Cloud Storage JSON API (UNTESTED: no bucket available when written) ----
// Auth: env.GCS_SERVICE_ACCOUNT (a service account key as JSON) if set, else the Cloud Run
// metadata server (the service's own account; give it roles/storage.objectAdmin on the bucket).
let gcsToken = null; // { token, exp }

async function gcsAccessToken(env) {
  if (gcsToken && gcsToken.exp > Date.now() + 60000) return gcsToken.token;
  let res;
  if (env.GCS_SERVICE_ACCOUNT) {
    const sa = JSON.parse(env.GCS_SERVICE_ACCOUNT);
    const iat = Math.floor(Date.now() / 1000);
    const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
    const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/devstorage.read_write',
      aud: 'https://oauth2.googleapis.com/token',
      iat,
      exp: iat + 3600,
    })}`;
    const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    const key = await crypto.subtle.importKey('pkcs8', fromBase64(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
    res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(sig)}` }),
    });
  } else {
    res = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
      headers: { 'Metadata-Flavor': 'Google' },
    });
  }
  if (!res.ok) throw new Error(`Google Cloud Storage sign-in failed (${res.status})`);
  const j = await res.json();
  gcsToken = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return gcsToken.token;
}

function gcsStore(env) {
  const bucket = encodeURIComponent(env.GCS_BUCKET);
  const name = (id) => encodeURIComponent(`attachments/${id}`);
  const call = async (url, init = {}) => {
    const token = await gcsAccessToken(env);
    return fetch(url, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${token}` } });
  };
  return {
    kind: 'gcs',
    async put(id, bytes, contentType) {
      const r = await call(`https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${name(id)}`, {
        method: 'POST',
        headers: { 'content-type': contentType || 'application/octet-stream' },
        body: bytes,
      });
      if (!r.ok) throw new Error(`Google Cloud Storage upload failed (${r.status})`);
    },
    async get(id) {
      const r = await call(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${name(id)}?alt=media`);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`Google Cloud Storage read failed (${r.status})`);
      return new Uint8Array(await r.arrayBuffer());
    },
    async delete(id) {
      const r = await call(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${name(id)}`, { method: 'DELETE' });
      if (!r.ok && r.status !== 404) throw new Error(`Google Cloud Storage delete failed (${r.status})`);
    },
  };
}

/**
 * Delete objects of attachments that live outside the database (R2/GCS), best effort.
 * rows: [{ id, storage }]. Database chunks go with the attachment rows (ON DELETE CASCADE).
 */
export async function deleteExternal(env, rows) {
  for (const r of rows) {
    if (r.storage === 'db') continue;
    try {
      await fileStore(env, r.storage)?.delete(r.id);
    } catch (e) {
      console.error('attachment delete failed', r.id, e?.message);
    }
  }
}

/**
 * Upload one object to a Google Cloud Storage bucket (the daily backup copy, GCS_BACKUP_BUCKET), with the same
 * sign-in as attachments. body may be a stream. UNTESTED: no bucket available when written.
 */
export async function gcsUpload(env, bucket, objectName, body, contentType) {
  const token = await gcsAccessToken(env);
  const r = await fetch(
    `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': contentType || 'application/octet-stream' },
      body,
      duplex: 'half',
    },
  );
  if (!r.ok) throw new Error(`Google Cloud Storage upload failed (${r.status})`);
}
