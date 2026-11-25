<script setup>
// Grouped bar chart: one group per label, one bar per series.
import { computed, ref } from 'vue';
import { useWidth, niceTicks, fmtNum, labelEvery, COLORS } from './chart.js';
import ChartData from './ChartData.vue';

const props = defineProps({
  title: { type: String, required: true },
  description: { type: String, default: '' },
  labels: { type: Array, required: true },
  series: { type: Array, required: true }, // [{ name, values, color }]
  height: { type: Number, default: 220 },
  labelHeader: { type: String, default: '' },
  legend: { type: Boolean, default: true },
  clickable: { type: Boolean, default: false }, // emit select(index) when a group is clicked or Enter is pressed
});
const emit = defineEmits(['select']);

const { el, width } = useWidth();
const pad = { left: 36, right: 8, top: 12, bottom: 26 };
const plotW = computed(() => width.value - pad.left - pad.right);
const plotH = computed(() => props.height - pad.top - pad.bottom);
const scale = computed(() => niceTicks(Math.max(0, ...props.series.flatMap((s) => s.values.map((v) => v || 0)))));
const band = computed(() => plotW.value / Math.max(1, props.labels.length));
const barW = computed(() => Math.max(2, Math.min(36, (band.value * 0.72) / props.series.length)));
const groupX = (i) => pad.left + i * band.value + band.value / 2;
const barX = (i, j) => groupX(i) - (barW.value * props.series.length) / 2 + j * barW.value;
const y = (v) => pad.top + plotH.value - ((v || 0) / scale.value.max) * plotH.value;
const every = computed(() => labelEvery(props.labels.length, plotW.value, 46));
// shorten long labels (sprint names) to the room one group has; the tooltip and table show them in full
function short(l) {
  const room = Math.max(3, Math.floor((band.value * every.value - 6) / 6.3));
  return String(l).length > room ? `${String(l).slice(0, room - 1)}…` : l;
}

const hover = ref(null);
function onMove(e) {
  const r = e.currentTarget.getBoundingClientRect();
  const px = ((e.clientX - r.left) / r.width) * width.value;
  const i = Math.floor((px - pad.left) / band.value);
  hover.value = i >= 0 && i < props.labels.length ? i : null;
}
function onClick(e) {
  if (!props.clickable) return;
  onMove(e); // a tap has no pointermove before it
  if (hover.value !== null) emit('select', hover.value);
}
function onKey(e) {
  const n = props.labels.length;
  if (!n) return;
  if (e.key === 'ArrowRight') hover.value = hover.value === null ? 0 : Math.min(n - 1, hover.value + 1);
  else if (e.key === 'ArrowLeft') hover.value = hover.value === null ? n - 1 : Math.max(0, hover.value - 1);
  else if (e.key === 'Escape') hover.value = null;
  else if (e.key === 'Enter' && props.clickable && hover.value !== null) emit('select', hover.value);
  else return;
  e.preventDefault();
}
const tipLeft = computed(() => (hover.value === null ? 0 : Math.min(Math.max(groupX(hover.value), 70), width.value - 70)));
</script>
<template>
  <div>
    <ul v-if="legend" class="mb-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600" aria-hidden="true">
      <li v-for="s in series" :key="s.name" class="flex items-center gap-1.5">
        <span class="inline-block h-2.5 w-2.5 rounded-sm" :style="{ background: s.color }"></span>{{ s.name }}
      </li>
    </ul>
    <div ref="el" class="relative w-full">
      <svg
        :viewBox="`0 0 ${width} ${height}`"
        :width="width"
        :height="height"
        class="block max-w-full touch-pan-y outline-none focus-visible:ring-2 focus-visible:ring-black"
        :class="clickable ? 'cursor-pointer' : ''"
        role="img"
        tabindex="0"
        :aria-label="`${title}. ${description} Use the arrow keys to read values.`"
        @click="onClick"
        @pointermove="onMove"
        @pointerleave="hover = null"
        @keydown="onKey"
        @blur="hover = null"
      >
        <title>{{ title }}</title>
        <rect v-if="hover !== null" :x="pad.left + hover * band" :y="pad.top" :width="band" :height="plotH" fill="#f3f4f8" />
        <g v-for="t in scale.ticks" :key="t">
          <line :x1="pad.left" :x2="width - pad.right" :y1="y(t)" :y2="y(t)" :stroke="COLORS.grid" stroke-width="1" />
          <text :x="pad.left - 6" :y="y(t) + 4" text-anchor="end" font-size="11" fill="#78716c">{{ fmtNum(t) }}</text>
        </g>
        <g v-for="(l, i) in labels" :key="i">
          <rect
            v-for="(s, j) in series"
            :key="s.name"
            :x="barX(i, j)"
            :y="y(s.values[i])"
            :width="Math.max(1, barW - 2)"
            :height="Math.max(0, pad.top + plotH - y(s.values[i]))"
            :fill="s.color"
            rx="2"
          />
          <text v-if="i % every === 0" :x="groupX(i)" :y="height - 8" text-anchor="middle" font-size="11" fill="#78716c">
            {{ short(l) }}
          </text>
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
          <span class="inline-block h-2 w-2 rounded-sm" :style="{ background: s.color }"></span>{{ s.name }}:
          <strong class="tabular-nums">{{ fmtNum(s.values[hover]) }}</strong>
        </div>
      </div>
    </div>
    <ChartData :labels="labels" :series="series" :label-header="labelHeader" />
  </div>
</template>
