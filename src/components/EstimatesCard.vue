<script setup>
// Estimates vs actuals per epic for one project (project Reports tab).
import { ref, watch } from 'vue';
import { get } from '../api.js';
import { fmtHours } from '../dates.js';
const props = defineProps({ projectKey: String });
const data = ref(null);
const error = ref('');
watch(
  () => props.projectKey,
  async (k) => {
    try {
      data.value = await get(`/api/projects/${k}/estimates`);
      error.value = '';
    } catch (e) {
      error.value = e.message;
    }
  },
  { immediate: true },
);
const h = (n) => `${fmtHours(n, 1)}h`;
const max = (rows) => Math.max(1, ...rows.map((r) => Math.max(r.estimate, r.logged)));
</script>
<template>
  <section class="card min-w-0 p-4 lg:col-span-2" aria-labelledby="r-est">
    <h3 id="r-est" class="font-semibold">Estimates vs actuals</h3>
    <p class="mb-3 text-xs text-slate-500">
      Estimated hours (from issue estimates) against hours logged, per epic. Sub-tasks count toward their story's epic.
    </p>
    <p v-if="error" class="text-sm text-red-700">{{ error }}</p>
    <template v-else-if="data">
      <p v-if="!data.totals.estimate && !data.totals.logged" class="py-8 text-center text-sm text-slate-500">
        No estimates or logged time yet. Add an estimate on an issue, or log work, to see this.
      </p>
      <template v-else>
        <div class="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div class="rounded-[15px] bg-slate-100 p-3">
            <div class="text-xs text-slate-500">Estimated</div>
            <div class="text-lg font-semibold">{{ h(data.totals.estimate) }}</div>
          </div>
          <div class="rounded-[15px] bg-slate-100 p-3">
            <div class="text-xs text-slate-500">Logged</div>
            <div class="text-lg font-semibold">{{ h(data.totals.logged) }}</div>
          </div>
          <div class="rounded-[15px] bg-slate-100 p-3">
            <div class="text-xs text-slate-500">Remaining</div>
            <div class="text-lg font-semibold">{{ h(data.totals.remaining) }}</div>
          </div>
          <div class="rounded-[15px] bg-slate-100 p-3">
            <div class="text-xs text-slate-500">Over or under</div>
            <div class="text-lg font-semibold" :class="data.totals.variance > 0 ? 'text-red-700' : ''">
              {{ data.totals.variance > 0 ? '+' : '' }}{{ h(data.totals.variance) }}
            </div>
          </div>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full min-w-[40rem] text-sm">
            <thead class="text-left text-xs uppercase text-slate-500">
              <tr>
                <th class="py-1.5 pr-2">Epic</th>
                <th class="py-1.5">Estimated vs logged</th>
                <th class="py-1.5 text-right">Est.</th>
                <th class="py-1.5 text-right">Logged</th>
                <th class="py-1.5 text-right">Over/under</th>
                <th class="py-1.5 text-right">Done</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in data.rows" :key="r.key || 'none'" class="border-t border-slate-100">
                <td class="max-w-[14rem] py-1.5 pr-2">
                  <RouterLink v-if="r.key" :to="`/browse/${r.key}`" class="hover:underline"
                    ><span class="font-medium text-slate-600">{{ r.key }}</span> {{ r.title }}</RouterLink
                  ><span v-else class="text-slate-500">{{ r.title }}</span>
                </td>
                <td class="w-1/3 py-1.5">
                  <div class="space-y-0.5" :title="`Estimated ${h(r.estimate)}, logged ${h(r.logged)}`">
                    <div class="h-2 rounded-full bg-slate-200" :style="{ width: `${(r.estimate / max(data.rows)) * 100}%` }"></div>
                    <div
                      class="h-2 rounded-full"
                      :class="r.logged > r.estimate && r.estimate ? 'bg-red-600' : 'bg-accent'"
                      :style="{ width: `${(r.logged / max(data.rows)) * 100}%` }"
                    ></div>
                  </div>
                </td>
                <td class="py-1.5 text-right tabular-nums">{{ h(r.estimate) }}</td>
                <td class="py-1.5 text-right tabular-nums">{{ h(r.logged) }}</td>
                <td class="py-1.5 text-right tabular-nums" :class="r.variance > 0 && r.estimate ? 'text-red-700' : ''">
                  {{
                    r.estimate
                      ? `${r.variance > 0 ? '+' : ''}${h(r.variance)}${r.variancePct !== null ? ` (${r.variancePct > 0 ? '+' : ''}${r.variancePct}%)` : ''}`
                      : ''
                  }}
                </td>
                <td class="py-1.5 text-right tabular-nums">{{ r.doneIssues }}/{{ r.issues }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="mt-2 text-xs text-slate-500">Grey bar: estimated. Orange: logged; red when logged is over the estimate.</p>
      </template>
    </template>
  </section>
</template>
