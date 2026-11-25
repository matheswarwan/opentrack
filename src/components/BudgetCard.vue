<script setup>
// Project Reports > Budget: burn-up chart, tiles, per-epic and per-person tables (server/lib/budgets.js).
// Project admins see money; members see hours and percentages; guests get a 404 and see nothing.
import { ref, computed, watch } from 'vue';
import { get } from '../api.js';
import { ui } from '../ui.js';
import LineChart from './charts/LineChart.vue';
import { COLORS } from './charts/chart.js';
import { fmtHours } from '../dates.js';

const props = defineProps({ projectKey: { type: String, required: true } });
const data = ref(null);
const error = ref('');
const hidden = ref(false);
watch(
  [() => props.projectKey, () => ui.changes],
  async ([k]) => {
    try {
      data.value = await get(`/api/projects/${k}/budget`);
      error.value = '';
      hidden.value = false;
    } catch (e) {
      if (e.status === 404) hidden.value = true;
      else error.value = e.message;
    }
  },
  { immediate: true },
);

const b = computed(() => data.value?.burn);
const money = computed(() => b.value?.budget.kind === 'money' && !b.value.hoursOnly);
const cur = computed(() => b.value?.budget.currency || '');
const h = (n) => `${fmtHours(n, 1)}h`;
const m = (n) => `${cur.value} ${Math.round(n || 0).toLocaleString()}`;
const val = (n) => (b.value?.budget.kind === 'money' ? m(n) : h(n));
const pct = (n) => (n === null || n === undefined ? '' : `${Math.round(n)}%`);
const short = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const long = (d) =>
  d
    ? new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
    : 'Unknown';

const tiles = computed(() => {
  const x = b.value;
  if (!x) return [];
  const f = x.forecast;
  if (x.hoursOnly && x.budget.kind === 'money') {
    return [
      ['Used', pct(x.usage.pctUsed), 'of the budget'],
      ['Hours logged', h(x.usage.hours), x.usage.nonBillableHours ? `${h(x.usage.nonBillableHours)} non-billable` : 'billable'],
      ['Hours remaining', h(f.remainingHours), 'from open estimates'],
      ['Forecast at completion', pct(f.atCompletionPct), 'of the budget'],
    ];
  }
  return [
    ['Budget', val(x.budget.amount), x.budget.endDate ? `until ${long(x.budget.endDate)}` : 'no end date'],
    [
      'Used',
      val(x.usage.value),
      `${h(x.usage.hours)} billable${x.usage.nonBillableHours ? `, ${h(x.usage.nonBillableHours)} non-billable` : ''}`,
    ],
    ['Remaining', val(x.usage.remaining), x.usage.remaining < 0 ? 'over budget' : 'left to spend'],
    ['% used', pct(x.usage.pctUsed), `alerts at ${x.budget.thresholds.join('% and ')}%`],
    ['Forecast at completion', val(f.atCompletion), `${pct(f.atCompletionPct)} of the budget`],
  ];
});
const chart = computed(() => {
  const x = b.value;
  if (!x?.chart.labels.length) return null;
  const s = x.chart.value || x.chart.hours;
  const series = [];
  if (s.budget) series.push({ name: 'Budget', color: COLORS.grey, values: s.budget });
  series.push({ name: 'Actual', color: COLORS.primary, values: s.actual });
  if (s.forecast.some((v) => v !== null)) series.push({ name: 'Forecast', color: COLORS.secondary, dashed: true, values: s.forecast });
  return { labels: x.chart.labels.map((d) => short(d)), series };
});
const unitWord = computed(() => (money.value ? cur.value : 'hours'));
const forecastLine = computed(() => {
  const f = b.value?.forecast;
  if (!f) return '';
  if (f.noEstimates) return 'No issues have hour estimates, so the forecast assumes no work is left.';
  const parts = [];
  parts.push(f.burnRateHours ? `Burning ${h(f.burnRateHours)} a week over the last 4 weeks.` : 'No billable work in the last 4 weeks.');
  if (f.finishDate)
    parts.push(
      `At that rate the remaining ${h(f.remainingHours)} finish around ${long(f.finishDate)}${f.finishAfterEnd ? ', after the budget end date' : ''}.`,
    );
  if (f.exhaustDate && f.overBudget) parts.push(`The budget runs out around ${long(f.exhaustDate)}.`);
  return parts.join(' ');
});
</script>
<template>
  <section v-if="!hidden" class="card min-w-0 p-4 lg:col-span-2" aria-labelledby="r-budget">
    <h3 id="r-budget" class="font-semibold">Budget</h3>
    <p v-if="error" class="text-sm text-red-700">{{ error }}</p>
    <template v-else-if="data">
      <p v-if="!b" class="py-6 text-center text-sm text-slate-500">
        No budget yet.<span v-if="data.canAdmin">
          Set one in <RouterLink :to="`/projects/${projectKey}/settings`" class="underline">Project settings</RouterLink>.</span
        >
      </p>
      <template v-else>
        <p class="mb-3 text-xs text-slate-500">
          {{ b.budget.kind === 'money' ? 'Money budget' : 'Hours budget'
          }}{{ b.budget.startDate ? ` from ${long(b.budget.startDate)}` : '' }}. Billable work only, as of {{ long(b.asOf) }}.
          <span v-if="money && data.burn.usage.unratedHours">
            {{ h(data.burn.usage.unratedHours) }} have no rate and cost nothing yet.</span
          >
        </p>
        <div class="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <div v-for="t in tiles" :key="t[0]" class="rounded-[15px] bg-slate-100 p-3">
            <div class="text-xs text-slate-500">{{ t[0] }}</div>
            <div
              class="text-lg font-semibold tabular-nums"
              :class="
                (t[0] === 'Remaining' && b.usage.remaining < 0) || (t[0].startsWith('Forecast') && b.forecast.overBudget)
                  ? 'text-red-700'
                  : ''
              "
            >
              {{ t[1] }}
            </div>
            <div class="text-xs text-slate-500">{{ t[2] }}</div>
          </div>
        </div>
        <LineChart
          v-if="chart"
          :title="`Budget burn-up (${unitWord})`"
          :description="`Cumulative ${unitWord} used each week against the budget, with the forecast to completion.`"
          :labels="chart.labels"
          :series="chart.series"
          label-header="Week starting"
        />
        <p class="mt-2 text-sm text-slate-600">{{ forecastLine }}</p>

        <div class="mt-4 grid gap-4 lg:grid-cols-2">
          <div class="min-w-0 overflow-x-auto">
            <h4 class="mb-1 text-sm font-semibold">By epic</h4>
            <table class="w-full text-sm">
              <thead class="text-left text-xs uppercase text-slate-500">
                <tr>
                  <th class="py-1.5 pr-2">Epic</th>
                  <th class="py-1.5 text-right">Hours</th>
                  <th v-if="money" class="py-1.5 text-right">Cost</th>
                  <th class="py-1.5 text-right">Budget</th>
                  <th class="py-1.5 text-right">Left to do</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="e in b.epics" :key="e.key || 'none'" class="border-t border-slate-100">
                  <td class="max-w-[12rem] py-1.5 pr-2">
                    <RouterLink v-if="e.key" :to="`/browse/${e.key}`" class="hover:underline"
                      ><span class="font-medium text-slate-600">{{ e.key }}</span> {{ e.title }}</RouterLink
                    ><span v-else class="text-slate-500">{{ e.title }}</span>
                  </td>
                  <td class="py-1.5 text-right tabular-nums">{{ h(e.hours) }}</td>
                  <td v-if="money" class="py-1.5 text-right tabular-nums">{{ m(e.cost) }}</td>
                  <td class="py-1.5 text-right tabular-nums" :class="e.pctUsed > 100 ? 'text-red-700' : ''">
                    {{ e.budgetHours ? `${h(e.budgetHours)} (${pct(e.pctUsed)})` : '' }}
                  </td>
                  <td class="py-1.5 text-right tabular-nums">{{ h(e.remainingHours) }}</td>
                </tr>
                <tr v-if="!b.epics.length">
                  <td colspan="5" class="py-3 text-center text-slate-500">No billable work yet.</td>
                </tr>
              </tbody>
            </table>
            <template v-if="b.components.length">
              <h4 class="mb-1 mt-3 text-sm font-semibold">By component</h4>
              <table class="w-full text-sm">
                <thead class="text-left text-xs uppercase text-slate-500">
                  <tr>
                    <th class="py-1.5 pr-2">Component</th>
                    <th class="py-1.5 text-right">Hours</th>
                    <th class="py-1.5 text-right">Budget</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="c in b.components" :key="c.id" class="border-t border-slate-100">
                    <td class="py-1.5 pr-2">{{ c.name }}</td>
                    <td class="py-1.5 text-right tabular-nums">{{ h(c.hours) }}</td>
                    <td class="py-1.5 text-right tabular-nums" :class="c.pctUsed > 100 ? 'text-red-700' : ''">
                      {{ h(c.budgetHours) }} ({{ pct(c.pctUsed) }})
                    </td>
                  </tr>
                </tbody>
              </table>
            </template>
          </div>
          <div class="min-w-0 overflow-x-auto">
            <h4 class="mb-1 text-sm font-semibold">By person</h4>
            <table class="w-full text-sm">
              <thead class="text-left text-xs uppercase text-slate-500">
                <tr>
                  <th class="py-1.5 pr-2">Person</th>
                  <th class="py-1.5 text-right">Billable</th>
                  <th class="py-1.5 text-right">Non-billable</th>
                  <th v-if="money" class="py-1.5 text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="p in b.people" :key="p.id || 'former'" class="border-t border-slate-100">
                  <td class="py-1.5 pr-2">{{ p.name }}</td>
                  <td class="py-1.5 text-right tabular-nums">{{ h(p.hours) }}</td>
                  <td class="py-1.5 text-right tabular-nums">{{ p.nonBillableHours ? h(p.nonBillableHours) : '' }}</td>
                  <td v-if="money" class="py-1.5 text-right tabular-nums">{{ m(p.cost) }}</td>
                </tr>
                <tr v-if="!b.people.length">
                  <td colspan="4" class="py-3 text-center text-slate-500">No work logged in the budget dates.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>
    </template>
  </section>
</template>
