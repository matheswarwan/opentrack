// Shared helpers for the inline SVG charts (no chart library).
import { ref, onMounted, onBeforeUnmount } from 'vue';

export const COLORS = {
  primary: '#1d7a46',
  black: '#18181b',
  grey: '#6f6f6b',
  lightGrey: '#a8a8a3',
  secondary: '#27272a',
  tertiary: '#b7791f',
  quaternary: '#8fb8a0',
  grid: '#e5e5e3',
};

/** Width of an element, kept up to date (charts draw at their real pixel width so text stays readable). */
export function useWidth(fallback = 640) {
  const el = ref(null);
  const width = ref(fallback);
  let ro = null;
  onMounted(() => {
    const update = () => {
      if (el.value) width.value = Math.max(240, Math.round(el.value.clientWidth || fallback));
    };
    update();
    if (typeof ResizeObserver !== 'undefined' && el.value) {
      ro = new ResizeObserver(update);
      ro.observe(el.value);
    }
  });
  onBeforeUnmount(() => ro?.disconnect());
  return { el, width };
}

/** A round axis maximum and its ticks (about 4 steps of 1, 2, 2.5 or 5 times a power of ten, whole steps for small counts). */
export function niceTicks(max, steps = 4) {
  if (!(max > 0)) return { max: 1, ticks: [0, 1] };
  const raw = max / steps;
  const pow = 10 ** Math.floor(Math.log10(raw));
  let step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) || 10 * pow;
  if (step < 1) step = 1;
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
  return { max: top, ticks };
}

export const fmtNum = (v) => (v === null || v === undefined ? 'No data' : Number.isInteger(v) ? String(v) : v.toFixed(1));

/** Print every n-th x label so they do not overlap. */
export function labelEvery(count, plotWidth, minGap = 58) {
  return Math.max(1, Math.ceil(count / Math.max(1, Math.floor(plotWidth / minGap))));
}
