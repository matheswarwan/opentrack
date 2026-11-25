<script setup>
// Donut chart with a legend. Segments and legend rows can be clicked (emits select with the index).
import { computed, ref } from 'vue';
import { fmtNum } from './chart.js';
import ChartData from './ChartData.vue';

const props = defineProps({
  title: { type: String, required: true },
  description: { type: String, default: '' },
  items: { type: Array, required: true }, // [{ label, value, color, clickable }]
  unit: { type: String, default: '' },
  labelHeader: { type: String, default: '' },
  size: { type: Number, default: 180 },
});
const emit = defineEmits(['select']);

const total = computed(() => props.items.reduce((s, x) => s + (x.value || 0), 0));
const R = 80;
const r = 50;
const arcs = computed(() => {
  let a = -Math.PI / 2;
  const t = total.value || 1;
  return props.items.map((x) => {
    const sweep = ((x.value || 0) / t) * Math.PI * 2;
    const start = a;
    a += sweep;
    return { start, end: a, sweep };
  });
});
function path({ start, end, sweep }) {
  if (sweep <= 0) return '';
  if (sweep >= Math.PI * 2 - 1e-6) {
    // full circle: two halves
    return `M0,${-R}A${R},${R} 0 1 1 0,${R}A${R},${R} 0 1 1 0,${-R}M0,${-r}A${r},${r} 0 1 0 0,${r}A${r},${r} 0 1 0 0,${-r}Z`;
  }
  const large = sweep > Math.PI ? 1 : 0;
  const p = (rad, ang) => `${(rad * Math.cos(ang)).toFixed(2)},${(rad * Math.sin(ang)).toFixed(2)}`;
  return `M${p(R, start)}A${R},${R} 0 ${large} 1 ${p(R, end)}L${p(r, end)}A${r},${r} 0 ${large} 0 ${p(r, start)}Z`;
}
const hover = ref(null);
const pct = (v) => (total.value ? Math.round(((v || 0) / total.value) * 100) : 0);
function onKey(e) {
  const n = props.items.length;
  if (!n) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') hover.value = hover.value === null ? 0 : (hover.value + 1) % n;
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') hover.value = hover.value === null ? n - 1 : (hover.value - 1 + n) % n;
  else if (e.key === 'Enter' && hover.value !== null) {
    if (props.items[hover.value].clickable !== false) emit('select', hover.value);
  } else if (e.key === 'Escape') hover.value = null;
  else return;
  e.preventDefault();
}
const shown = computed(() => (hover.value === null ? null : props.items[hover.value]));
</script>
<template>
  <div>
    <div class="flex flex-wrap items-center gap-4">
      <svg
        :width="size"
        :height="size"
        viewBox="-90 -90 180 180"
        class="shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-black"
        role="img"
        tabindex="0"
        :aria-label="`${title}. ${description} Use the arrow keys to read values and Enter to open the issues.`"
        @keydown="onKey"
        @blur="hover = null"
      >
        <title>{{ title }}</title>
        <circle v-if="!total" r="65" fill="none" stroke="#e4e7ee" stroke-width="30" />
        <path
          v-for="(a, i) in arcs"
          :key="i"
          :d="path(a)"
          :fill="items[i].color"
          stroke="#fff"
          stroke-width="1.5"
          :opacity="hover === null || hover === i ? 1 : 0.45"
          :class="items[i].clickable === false ? '' : 'cursor-pointer'"
          @pointerenter="hover = i"
          @pointerleave="hover = null"
          @click="items[i].clickable !== false && emit('select', i)"
        />
        <text y="-2" text-anchor="middle" font-size="20" font-weight="700" fill="#000">{{ fmtNum(shown ? shown.value : total) }}</text>
        <text y="16" text-anchor="middle" font-size="10" fill="#78716c">{{ shown ? `${pct(shown.value)}%` : unit || 'total' }}</text>
      </svg>
      <ul class="min-w-0 flex-1 space-y-0.5 text-sm" style="min-width: 10rem">
        <li v-for="(x, i) in items" :key="i">
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded px-1.5 py-0.5 text-left hover:bg-slate-100 disabled:cursor-default disabled:hover:bg-transparent"
            :class="hover === i ? 'bg-slate-100' : ''"
            :disabled="x.clickable === false"
            @pointerenter="hover = i"
            @pointerleave="hover = null"
            @click="emit('select', i)"
          >
            <span class="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" :style="{ background: x.color }"></span>
            <span class="min-w-0 flex-1 truncate">{{ x.label }}</span>
            <span class="tabular-nums text-slate-600">{{ fmtNum(x.value) }}</span>
            <span class="w-9 text-right text-xs tabular-nums text-slate-500">{{ pct(x.value) }}%</span>
          </button>
        </li>
      </ul>
    </div>
    <ChartData
      :labels="items.map((x) => x.label)"
      :series="[{ name: unit || 'Value', values: items.map((x) => x.value) }]"
      :label-header="labelHeader"
    />
  </div>
</template>
