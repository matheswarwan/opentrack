// Small browser chores every page did by hand: save text as a file, copy text to the clipboard.
import { toast } from './api.js';

/** Hand the person a file to save: downloadText('week.csv', text, 'text/csv'). */
export function downloadText(filename, text, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * Copy text to the clipboard and say so: the `ok` toast when it worked, the `fail` toast when the browser
 * refuses (no permission, not a secure page). Resolves to true when the text was copied.
 */
export async function copyText(text, { ok = 'Copied', fail = 'Could not copy. Select the text and copy it yourself.' } = {}) {
  try {
    await navigator.clipboard.writeText(text);
    toast(ok);
    return true;
  } catch {
    toast(fail, 'error');
    return false;
  }
}
