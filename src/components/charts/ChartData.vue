<script setup>
// "Show data" toggle with the chart's numbers as a table (for screen readers and exact values).
import { ref } from 'vue';
import { fmtNum } from './chart.js';

defineProps({
  labels: { type: Array, required: true },
  series: { type: Array, required: true }, // [{ name, values }]
  labelHeader: { type: String, default: '' },
});
const open = ref(false);
</script>
<template>
  <div class="mt-1">
    <button type="button" class="btn btn-ghost btn-sm" :aria-expanded="open" @click="open = !open">
      {{ open ? 'Hide data' : 'Show data' }}
    </button>
    <div v-if="open" class="mt-1 max-h-72 overflow-auto rounded-md border border-slate-200">
      <table class="w-full text-left text-xs">
        <thead class="sticky top-0 bg-slate-50 text-slate-600">
          <tr>
            <th scope="col" class="px-2 py-1 font-semibold">{{ labelHeader }}</th>
            <th v-for="s in series" :key="s.name" scope="col" class="px-2 py-1 text-right font-semibold">{{ s.name }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(l, i) in labels" :key="i" class="border-t border-slate-100">
            <th scope="row" class="whitespace-nowrap px-2 py-1 font-normal">{{ l }}</th>
            <td v-for="s in series" :key="s.name" class="px-2 py-1 text-right tabular-nums">{{ fmtNum(s.values[i]) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
