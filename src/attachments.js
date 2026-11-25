// Attachment uploads. Multipart can't go through the JSON helper in api.js, so this uses XHR
// (for progress) and sends the same CSRF header.
import { recordFailedRequest } from './diagnostics.js';

export const MAX_UPLOAD_MB = 25; // the server says 10 MB when files are kept in the database

// opts.internal: the file belongs to an internal note, so guests never see it.
export function uploadAttachment(issueKey, file, onProgress, opts = {}) {
  const path = `/api/issues/${encodeURIComponent(issueKey)}/attachments${opts.internal ? '?internal=1' : ''}`;
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file, file.name || 'file');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.withCredentials = true;
    xhr.setRequestHeader('x-requested-with', 'opentrack');
    if (onProgress) xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data.attachment);
      const msg = data?.error || (xhr.status === 413 ? 'The file is too large' : `Upload failed (${xhr.status})`);
      recordFailedRequest('POST', path, xhr.status, msg);
      reject(new Error(`${file.name}: ${msg}`));
    };
    xhr.onerror = () => reject(new Error(`${file.name}: upload failed, check your connection`));
    xhr.send(form);
  });
}

export const isImage = (a) => /^image\/(png|jpeg|gif|webp)$/.test(a.contentType || a.type || '');

export function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Markdown for an uploaded attachment: an image for pictures, a link otherwise. */
export function attachmentMarkdown(a) {
  const name = a.filename.replace(/[[\]\\]/g, '');
  return isImage(a) ? `![${name}](${a.url})` : `[${name}](${a.url})`;
}

/** A pasted image is usually called image.png; give it a readable unique name. */
export function namePasted(file) {
  if (file.name && file.name !== 'image.png') return file;
  const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  return new File([file], `pasted-${stamp}.${ext}`, { type: file.type });
}
