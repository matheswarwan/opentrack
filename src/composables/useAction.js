// One way to run something the user asked for (save, delete, send): await it, say what
// happened, and never leave a rejected promise unhandled.
import { ref } from 'vue';
import { toast } from '../api.js';

/**
 * Run fn. On success: `then(result)` (reload, close a dialog), then the `ok` toast (text, or
 * a function of the result). On failure (fn or then): a red toast with the error message.
 * Returns true when it worked, false when it failed, so callers can stop there.
 */
export async function attempt(fn, { ok, then } = {}) {
  try {
    const result = await fn();
    if (then) await then(result);
    const message = typeof ok === 'function' ? ok(result) : ok;
    if (message) toast(message);
    return true;
  } catch (e) {
    toast(e.message, 'error');
    return false;
  }
}

/** attempt() plus a `busy` ref that is true while the action runs (to disable its buttons). */
export function useAction() {
  const busy = ref(false);
  async function run(fn, opts) {
    busy.value = true;
    try {
      return await attempt(fn, opts);
    } finally {
      busy.value = false;
    }
  }
  return { busy, run };
}
