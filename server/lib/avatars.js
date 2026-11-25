/** Profile photo URL for a user, or null when they have none. `version` is users.avatar_version. */
export function avatarUrl(userId, version) {
  return userId && version ? `/api/users/${userId}/avatar?v=${encodeURIComponent(version)}` : null;
}

export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const MAX_AVATAR_BYTES = 200 * 1024;

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function looksLike(type, bytes) {
  const at = (i, arr) => arr.every((v, k) => bytes[i + k] === v);
  if (type === 'image/png') return at(0, [0x89, 0x50, 0x4e, 0x47]);
  if (type === 'image/jpeg') return at(0, [0xff, 0xd8, 0xff]);
  if (type === 'image/webp') return at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50]);
  return false;
}

/**
 * Check an uploaded photo (a base64 data URL). Returns { type } when it is fine,
 * { error } otherwise.
 */
export function checkAvatar(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl) return { error: 'image is required' };
  if (dataUrl.length > MAX_AVATAR_BYTES * 1.4 + 100) return { error: 'The photo is too large (max 200 KB)' };
  const m = dataUrl.match(/^data:(image\/[a-z]+);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!m) return { error: 'image must be a base64 data URL' };
  if (!AVATAR_TYPES.includes(m[1])) return { error: 'The photo must be a PNG, JPEG or WebP image' };
  let bytes;
  try {
    bytes = b64ToBytes(m[2]);
  } catch {
    return { error: 'image must be a base64 data URL' };
  }
  if (bytes.length > MAX_AVATAR_BYTES) return { error: 'The photo is too large (max 200 KB)' };
  if (!looksLike(m[1], bytes)) return { error: 'The file is not a valid image' };
  return { type: m[1] };
}

/** Split a stored data URL into its content type and bytes. */
export function decodeAvatar(dataUrl) {
  const m = String(dataUrl).match(/^data:(image\/[a-z]+);base64,(.*)$/);
  if (!m) return null;
  return { type: m[1], bytes: b64ToBytes(m[2]) };
}
