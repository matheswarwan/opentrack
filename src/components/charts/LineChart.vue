<script setup>
// Line chart over categorical x labels. Values may be null (gaps, e.g. future days).
import { computed, ref } from 'vue';
import { useWidth, niceTicks, fmtNum, labelEvery, COLORS } from './chart.js';
import ChartData from './ChartData.vue';

const props = defineProps({
  title: { type: String, required: true },
  description: { type: String, default: '' },
  labels: { type: Array, required: true },
  series: { type: Array, required: true }, // [{ name, values, color, dashed }]
  height: { type: Number, default: 240 },
  labelHeader: { type: String, default: '' },
});

const { el, width } = useWidth();
const pad = { left: 36, right: 12, top: 12, bottom: 26 };
const plotW = computed(() => width.value - pad.left - pad.right);
const plotH = computed(() => props.height - pad.top - pad.bottom);
const scale = computed(() => niceTicks(Math.max(0, ...props.series.flatMap((s) => s.values.filter((v) => v !== null && v !== undefined)))));
const step = computed(() => (props.labels.length > 1 ? plotW.value / (props.labels.length - 1) : 0));
const x = (i) => pad.left + (props.labels.length > 1 ? i * step.value : plotW.value / 2);
const y = (v) => pad.top + plotH.value - (v / scale.value.max) * plotH.value;
const shown = computed(() => {
  // every n-th label, always the last one, dropping the one before it when they would touch
  const n = props.labels.length;
  const every = labelEvery(n, plotW.value);
  const set = new Set();
  for (let i = 0; i < n; i += every) set.add(i);
  if (n > 1) {
    const prev = Math.floor((n - 1) / every) * every;
    if (prev !== 0 && prev !== n - 1 && n - 1 - prev < every * 0.75) set.delete(prev);
    set.add(n - 1);
  }
  return set;
});

function pathOf(values) {
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (v === null || v === undefined) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

const hover = ref(null);
function onMove(e) {
  const r = e.currentTarget.getBoundingClientRect();
  const px = ((e.clientX - r.left) / r.width) * width.value;
  const i = step.value ? Math.round((px - pad.left) / step.value) : 0;
  hover.value = Math.min(props.labels.length - 1, Math.max(0, i));
}
function onKey(e) {
  const n = props.labels.length;
  if (!n) return;
  if (e.key === 'ArrowRight') hover.value = hover.value === null ? 0 : Math.min(n - 1, hover.value + 1);
  else if (e.key === 'ArrowLeft') hover.value = hover.value === null ? n - 1 : Math.max(0, hover.value - 1);
  else if (e.key === 'Escape') hover.value = null;
  else return;
  e.preventDefault();
}
const tipLeft = computed(() => (hover.value === null ? 0 : Math.min(Math.max(x(hover.value), 70), width.value - 70)));
</script>
<template>
  <div>
    <ul class="mb-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600" aria-hidden="true">
      <li v-for="s in series" :key="s.name" class="flex items-center gap-1.5">
        <svg width="18" height="8">
          <line x1="0" y1="4" x2="18" y2="4" :stroke="s.color" stroke-width="2.5" :stroke-dasharray="s.dashed ? '4 3' : null" /></svg
        >{{ s.name }}
      </li>
    </ul>
    <div ref="el" class="relative w-full">
      <svg
        :viewBox="`0 0 ${width} ${height}`"
        :width="width"
        :height="height"
        class="block max-w-full touch-pan-y outline-none focus-visible:ring-2 focus-visible:ring-black"
        role="img"
        tabindex="0"
        :aria-label="`${title}. ${description} Use the arrow keys to read values.`"
        @pointermove="onMove"
        @pointerleave="hover = null"
        @keydown="onKey"
        @blur="hover = null"
      >
        <title>{{ title }}</title>
        <g v-for="t in scale.ticks" :key="t">
          <line :x1="pad.left" :x2="width - pad.right" :y1="y(t)" :y2="y(t)" :stroke="COLORS.grid" stroke-width="1" />
          <text :x="pad.left - 6" :y="y(t) + 4" text-anchor="end" font-size="11" fill="#78716c">{{ fmtNum(t) }}</text>
        </g>
        <template v-for="(l, i) in labels" :key="i">
          <text
            v-if="shown.has(i)"
            :x="x(i)"
            :y="height - 8"
            font-size="11"
            fill="#78716c"
            :text-anchor="i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle'"
          >
            {{ l }}
          </text>
        </template>
        <line v-if="hover !== null" :x1="x(hover)" :x2="x(hover)" :y1="pad.top" :y2="pad.top + plotH" stroke="#000" stroke-opacity="0.25" />
        <g v-for="s in series" :key="s.name">
          <path
            :d="pathOf(s.values)"
            fill="none"
            :stroke="s.color"
            :stroke-width="s.dashed ? 1.5 : 2.5"
            :stroke-dasharray="s.dashed ? '5 4' : null"
            stroke-linejoin="round"
            stroke-linecap="round"
          />
          <template v-if="!s.dashed">
            <circle
              v-for="(v, i) in s.values"
              v-show="v !== null && v !== undefined"
              :key="i"
              :cx="x(i)"
              :cy="y(v ?? 0)"
              :r="hover === i ? 4.5 : 2.5"
              :fill="s.color"
              stroke="#fff"
              stroke-width="1"
            />
          </template>
        </g>
      </svg>
      <div
        v-if="hover !== null"
        class="pointer-events-none absolute top-1 z-10 -translate-x-1/2 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs shadow-md"
        :style="{ left: `${(tipLeft / width) * 100}%` }"
        role="status"
      >
        <div class="font-semibold">{{ labels[hover] }}</div>
        <div v-for="s in series" :key="s.name" class="flex items-center gap-1.5 whitespace-nowrap">
          <span class="inline-block h-2 w-2 rounded-full" :style="{ background: s.color }"></span>{{ s.name }}:
          <strong class="tabular-nums">{{ fmtNum(s.values[hover]) }}</strong>
        </div>
      </div>
    </div>
    <ChartData :labels="labels" :series="series" :label-header="labelHeader" />
  </div>
</template>
