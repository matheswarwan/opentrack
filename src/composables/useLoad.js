// One way to load what a view shows. A failed first load ends in `error` (shown by
// <LoadState> with a Try again button), never in an endless skeleton.
import { ref, watch } from 'vue';
import { toast } from '../api.js';

/**
 * fetcher: async () => value for `data`.
 * sources: optional watch source(s); the fetcher runs at once and again when they change.
 *          Without sources it runs once, at once.
 * opts.initial: value of `data` before the first load (default null).
 * opts.eachTime: show `loading` on every reload, not only until the first data arrives.
 * opts.manual: do not load at once; the view calls reload() itself (it has work to do first).
 *
 * A reload that fails after data was shown keeps that data and says so in a toast;
 * only a view with nothing to show gets the error state. A slower earlier request never
 * overwrites a later one.
 */
export function useLoad(fetcher, sources, { initial = null, eachTime = false, manual = false } = {}) {
  const data = ref(initial);
  const loading = ref(true);
  const error = ref('');
  let seq = 0;
  let loaded = false;

  async function reload() {
    const mine = ++seq;
    if (eachTime || !loaded) loading.value = true;
    try {
      const value = await fetcher();
      if (mine !== seq) return;
      data.value = value;
      loaded = true;
      error.value = '';
    } catch (e) {
      if (mine !== seq) return;
      const message = e?.message || 'Could not load';
      if (loaded) toast(message, 'error');
      else error.value = message;
    } finally {
      if (mine === seq) loading.value = false;
    }
  }

  if (sources) watch(sources, () => reload(), { immediate: !manual });
  else if (!manual) reload();
  return { data, loading, error, reload };
}
