<script setup>
// Draws one custom report result (from POST /api/report-data). Clicking a segment, cell or row opens
// the matching issues in /issues.
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import PieChart from '../charts/PieChart.vue';
import BarChart from '../charts/BarChart.vue';
import LineChart from '../charts/LineChart.vue';
import TwoDTable from '../charts/TwoDTable.vue';
import Avatar from '../Avatar.vue';
import StatusBadge from '../StatusBadge.vue';
import { COLORS } from '../charts/chart.js';
import { metricOf, groupColor, issuesLink, fmt, shortDate, monthLabel, COLUMNS } from '../../reports.js';
import { typeOf, priorityOf, fmtDate } from '../../meta.js';
import { today as localToday } from '../../dates.js';

const props = defineProps({
  result: { type: Object, required: true },
  title: { type: String, default: 'Report' },
});
const router = useRouter();
const r = computed(() => props.result);
const open = (filter) => router.push(issuesLink(r.value.query, filter));

// ---- breakdown ----
const items = computed(() =>
  (r.value.groups || []).map((g, i) => ({ label: g.label, value: g.value, color: groupColor(g, i), clickable: Boolean(g.filter) })),
);
const unit = computed(() => metricOf(r.value.metric).unit);
function selectGroup(i) {
  const g = r.value.groups[i];
  if (g?.filter) open(g.filter);
}
const maxGroup = computed(() => Math.max(1, ...(r.value.groups || []).map((g) => g.value)));

// ---- twoD ----
const twoRows = computed(() => (r.value.rows || []).map((x) => ({ ...x, other: x.other || !x.filter })));
const twoCols = computed(() => (r.value.columns || []).map((x) => ({ ...x, other: x.other || !x.filter })));
function selectCell(ri, ci) {
  open({ ...(ri === null ? {} : r.value.rows[ri].filter), ...(ci === null ? {} : r.value.columns[ci].filter) });
}

// ---- time series ----
const periodLabel = (d) => (r.value.period === 'month' ? monthLabel(d) : shortDate(d));
const cvr = computed(
  () =>
    r.value.kind === 'createdVsResolved' && {
      labels: r.value.periods.map(periodLabel),
      series: [
        { name: 'Created', color: COLORS.primary, values: r.value.created },
        { name: 'Resolved', color: COLORS.secondary, values: r.value.resolved },
      ],
    },
);
const age = computed(
  () =>
    r.value.kind === 'averageAge' && {
      labels: r.value.points.map((p) => periodLabel(p.start)),
      series: [{ name: 'Average age (days)', color: COLORS.primary, values: r.value.points.map((p) => p.averageDays) }],
    },
);
const periodWord = computed(() => ({ day: 'Day', week: 'Week of', month: 'Month' })[r.value.period] || 'Period');

// ---- workload ----
const maxIssues = computed(() => Math.max(1, ...(r.value.people || []).map((p) => p.issues)));

// ---- list ----
const cols = computed(() => (r.value.columns || []).map((id) => COLUMNS.find((c) => c.id === id)).filter(Boolean));
function cell(i, id) {
  switch (id) {
    case 'type':
      return typeOf(i.type).label;
    case 'priority':
      return priorityOf(i.priority).label;
    case 'reporter':
      return i.reporter?.name || '';
    case 'project':
      return i.project.key;
    case 'sprint':
      return i.sprint?.name || '';
    case 'points':
      return fmt(i.points);
    case 'estimate':
      return i.estimate === null || i.estimate === undefined ? '' : `${fmt(i.estimate)} h`;
    case 'created':
    case 'updated':
    case 'due':
    case 'resolved':
      return fmtDate(i[id]);
    default:
      return i[id] ?? '';
  }
}
const today = localToday();
</script>
<template>
  <div class="min-w-0">
    <!-- breakdown -->
    <template v-if="r.kind === 'breakdown'">
      <p v-if="!r.groups.length" class="py-8 text-center text-sm text-slate-500">No issues match.</p>
      <PieChart
        v-else-if="r.chart === 'pie'"
        :title="title"
        :description="`${metricOf(r.metric).label} by ${r.groupLabel.toLowerCase()}.`"
        :items="items"
        :unit="unit"
        :label-header="r.groupLabel"
        @select="selectGroup"
      />
      <BarChart
        v-else-if="r.chart === 'bar'"
        :title="title"
        :description="`${metricOf(r.metric).label} by ${r.groupLabel.toLowerCase()}.`"
        :labels="r.groups.map((g) => g.label)"
        :series="[{ name: metricOf(r.metric).label, color: COLORS.primary, values: r.groups.map((g) => g.value) }]"
        :legend="false"
        :label-header="r.groupLabel"
        clickable
        @select="selectGroup"
      />
      <div v-else class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="text-xs text-slate-500">
            <tr>
              <th class="px-2 py-1 text-left font-semibold">{{ r.groupLabel }}</th>
              <th class="px-2 py-1 text-right font-semibold">{{ metricOf(r.metric).label }}</th>
              <th class="w-2/5 px-2 py-1"><span class="sr-only">Share</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(g, i) in r.groups" :key="g.key" class="border-t border-slate-100">
              <td class="max-w-[14rem] truncate px-2 py-1">
                <button v-if="g.filter" type="button" class="link" @click="selectGroup(i)">{{ g.label }}</button>
                <span v-else>{{ g.label }}</span>
              </td>
              <td class="px-2 py-1 text-right tabular-nums">{{ fmt(g.value) }}</td>
              <td class="px-2 py-1">
                <span class="block h-2 rounded-sm bg-slate-100"
                  ><span
                    class="block h-full rounded-sm"
                    :style="{ width: `${(g.value / maxGroup) * 100}%`, background: groupColor(g, i) }"
                  ></span
                ></span>
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr class="border-t border-slate-300 font-semibold">
              <td class="px-2 py-1">Total</td>
              <td class="px-2 py-1 text-right tabular-nums">{{ fmt(r.total) }}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p v-if="r.groupBy === 'label' && r.groups.length" class="mt-1 text-xs text-slate-500">
        An issue with several labels counts once per label ({{ r.issues }} issues in all).
      </p>
    </template>

    <!-- two-dimensional -->
    <template v-else-if="r.kind === 'twoD'">
      <p v-if="!r.rows.length" class="py-8 text-center text-sm text-slate-500">No issues match.</p>
      <TwoDTable
        v-else
        :rows="twoRows"
        :columns="twoCols"
        :cells="r.cells"
        :rows-label="r.rowsLabel"
        :columns-label="r.columnsLabel"
        :total="r.total"
        @select="selectCell"
      />
      <p v-if="r.metric !== 'count'" class="mt-1 text-xs text-slate-500">Values are {{ metricOf(r.metric).label.toLowerCase() }}.</p>
    </template>

    <!-- created vs resolved -->
    <template v-else-if="r.kind === 'createdVsResolved'">
      <p class="mb-1 text-xs text-slate-500">
        {{ r.totals.created }} created, {{ r.totals.resolved }} resolved in the last {{ r.days }} days{{
          r.cumulative ? ' (running totals)' : ''
        }}.
      </p>
      <BarChart
        v-if="r.chart === 'bar'"
        :title="title"
        description="Issues created and resolved per period."
        :labels="cvr.labels"
        :series="cvr.series"
        :label-header="periodWord"
      />
      <LineChart
        v-else
        :title="title"
        description="Issues created and resolved per period."
        :labels="cvr.labels"
        :series="cvr.series"
        :label-header="periodWord"
      />
    </template>

    <!-- average age -->
    <template v-else-if="r.kind === 'averageAge'">
      <p class="mb-1 text-xs text-slate-500">
        Average age of issues that were not resolved at the end of each period. Now: {{ r.points.at(-1)?.open ?? 0 }} open,
        {{ fmt(r.points.at(-1)?.averageDays) || 'no' }} days on average.
      </p>
      <LineChart
        :title="title"
        description="Average age in days of unresolved issues."
        :labels="age.labels"
        :series="age.series"
        :label-header="periodWord"
      />
      <p v-if="r.truncated" class="mt-1 text-xs text-slate-500">
        Worked out from the first 20,000 matching issues. Narrow the source for exact numbers.
      </p>
    </template>

    <!-- workload -->
    <template v-else-if="r.kind === 'workload'">
      <p v-if="!r.people.length" class="py-8 text-center text-sm text-slate-500">No {{ r.includeDone ? '' : 'open ' }}issues match.</p>
      <div v-else class="overflow-x-auto">
        <table class="w-full min-w-[340px] text-sm">
          <thead class="text-xs text-slate-500">
            <tr>
              <th class="px-2 py-1 text-left font-semibold">Assignee</th>
              <th class="px-2 py-1 text-right font-semibold">Issues</th>
              <th class="px-2 py-1 text-right font-semibold">Points</th>
              <th class="px-2 py-1 text-right font-semibold">Estimate</th>
              <th class="px-2 py-1 text-right font-semibold">Logged</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in r.people" :key="p.id || p.name" class="border-t border-slate-100">
              <td class="max-w-[12rem] px-2 py-1">
                <div class="flex items-center gap-2">
                  <Avatar v-if="p.id" :user="{ name: p.name }" :size="20" />
                  <RouterLink v-if="p.filter" :to="issuesLink(r.query, p.filter)" class="link truncate">{{ p.name }}</RouterLink>
                  <span v-else class="truncate">{{ p.name }}</span>
                </div>
                <span class="mt-0.5 block h-1.5 rounded-sm bg-slate-100" aria-hidden="true"
                  ><span
                    class="block h-full rounded-sm"
                    :style="{ width: `${(p.issues / maxIssues) * 100}%`, background: p.id ? COLORS.primary : COLORS.lightGrey }"
                  ></span
                ></span>
              </td>
              <td class="px-2 py-1 text-right tabular-nums">{{ p.issues }}</td>
              <td class="px-2 py-1 text-right tabular-nums">{{ fmt(p.points) }}</td>
              <td class="px-2 py-1 text-right tabular-nums">{{ fmt(p.estimateHours) }} h</td>
              <td class="px-2 py-1 text-right tabular-nums">{{ fmt(p.loggedHours) }} h</td>
            </tr>
          </tbody>
          <tfoot>
            <tr class="border-t border-slate-300 font-semibold">
              <td class="px-2 py-1">Total</td>
              <td class="px-2 py-1 text-right tabular-nums">{{ r.totals.issues }}</td>
              <td class="px-2 py-1 text-right tabular-nums">{{ fmt(r.totals.points) }}</td>
              <td class="px-2 py-1 text-right tabular-nums">{{ fmt(r.totals.estimateHours) }} h</td>
              <td class="px-2 py-1 text-right tabular-nums">{{ fmt(r.totals.loggedHours) }} h</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </template>

    <!-- list -->
    <template v-else-if="r.kind === 'list'">
      <p v-if="!r.issues.length" class="py-8 text-center text-sm text-slate-500">No issues match.</p>
      <div v-else class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="text-xs text-slate-500">
            <tr>
              <th v-for="c in cols" :key="c.id" class="whitespace-nowrap px-2 py-1 text-left font-semibold">{{ c.label }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="i in r.issues" :key="i.key" class="border-t border-slate-100">
              <td
                v-for="c in cols"
                :key="c.id"
                class="px-2 py-1"
                :class="c.id === 'title' ? 'max-w-[18rem] truncate' : 'whitespace-nowrap'"
              >
                <RouterLink v-if="c.id === 'key'" :to="`/browse/${i.key}`" class="link">{{ i.key }}</RouterLink>
                <RouterLink v-else-if="c.id === 'title'" :to="`/browse/${i.key}`" class="hover:underline">{{ i.title }}</RouterLink>
                <StatusBadge v-else-if="c.id === 'status'" :status="i.status" />
                <span v-else-if="c.id === 'assignee'" class="flex items-center gap-1.5">
                  <template v-if="i.assignee"><Avatar :user="i.assignee" :size="20" />{{ i.assignee.name }}</template>
                  <span v-else class="text-slate-500">Unassigned</span>
                </span>
                <span
                  v-else
                  :class="c.id === 'due' && i.due && i.due < today && i.status.category !== 'done' ? 'font-semibold text-red-700' : ''"
                  >{{ cell(i, c.id) }}</span
                >
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="r.total > r.issues.length" class="mt-1 text-xs text-slate-500">Showing {{ r.issues.length }} of {{ r.total }}.</p>
    </template>
  </div>
</template>
