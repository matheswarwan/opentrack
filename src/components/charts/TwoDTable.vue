<script setup>
// Two-dimensional statistics table (rows field x columns field) with totals. Cells and headers can be
// clicked: emits select(rowIndex, colIndex), either may be null for a whole row or column.
import { computed } from 'vue';
import { fmtNum } from './chart.js';

const props = defineProps({
  rows: { type: Array, required: true }, // [{ label, total, filter, other }]
  columns: { type: Array, required: true },
  cells: { type: Array, required: true }, // [row][col]
  rowsLabel: { type: String, default: '' },
  columnsLabel: { type: String, default: '' },
  total: { type: Number, default: 0 },
});
const emit = defineEmits(['select']);
const max = computed(() => Math.max(1, ...props.cells.flat()));
// light accent shading so bigger numbers stand out
const shade = (v) => (v ? `rgba(29, 122, 70, ${(0.06 + 0.3 * (v / max.value)).toFixed(3)})` : 'transparent');
const clickable = (ri, ci) => (ri === null || !props.rows[ri].other) && (ci === null || !props.columns[ci].other);
</script>
<template>
  <div class="max-h-[28rem] overflow-auto rounded-md border border-slate-200">
    <table class="w-full text-sm">
      <thead class="sticky top-0 z-10 bg-slate-50 text-xs text-slate-600">
        <tr>
          <th scope="col" class="sticky left-0 bg-slate-50 px-2 py-1.5 text-left font-semibold">{{ rowsLabel }} / {{ columnsLabel }}</th>
          <th v-for="(c, ci) in columns" :key="c.key" scope="col" class="whitespace-nowrap px-2 py-1.5 text-right font-semibold">
            <button v-if="clickable(null, ci)" type="button" class="hover:underline" @click="emit('select', null, ci)">
              {{ c.label }}
            </button>
            <span v-else>{{ c.label }}</span>
          </th>
          <th scope="col" class="px-2 py-1.5 text-right font-semibold">Total</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(r, ri) in rows" :key="r.key" class="border-t border-slate-100">
          <th scope="row" class="sticky left-0 max-w-[12rem] truncate bg-white px-2 py-1 text-left font-normal" :title="r.label">
            <button
              v-if="clickable(ri, null)"
              type="button"
              class="max-w-full truncate text-left hover:underline"
              @click="emit('select', ri, null)"
            >
              {{ r.label }}
            </button>
            <span v-else>{{ r.label }}</span>
          </th>
          <td
            v-for="(c, ci) in columns"
            :key="c.key"
            class="px-0 py-0 text-right tabular-nums"
            :style="{ background: shade(cells[ri][ci]) }"
          >
            <button
              v-if="cells[ri][ci] && clickable(ri, ci)"
              type="button"
              class="w-full px-2 py-1 text-right hover:underline"
              :aria-label="`${r.label}, ${c.label}: ${fmtNum(cells[ri][ci])}`"
              @click="emit('select', ri, ci)"
            >
              {{ fmtNum(cells[ri][ci]) }}
            </button>
            <span v-else class="block px-2 py-1" :class="cells[ri][ci] ? '' : 'text-slate-300'">{{ fmtNum(cells[ri][ci]) }}</span>
          </td>
          <td class="px-2 py-1 text-right font-semibold tabular-nums">{{ fmtNum(r.total) }}</td>
        </tr>
      </tbody>
      <tfoot class="border-t border-slate-300 bg-slate-50 text-xs">
        <tr>
          <th scope="row" class="sticky left-0 bg-slate-50 px-2 py-1.5 text-left font-semibold">Total</th>
          <td v-for="c in columns" :key="c.key" class="px-2 py-1.5 text-right font-semibold tabular-nums">{{ fmtNum(c.total) }}</td>
          <td class="px-2 py-1.5 text-right font-bold tabular-nums">{{ fmtNum(total) }}</td>
        </tr>
      </tfoot>
    </table>
  </div>
</template>
