<script setup>
import { ref, computed, inject, watch } from 'vue';
import EstimatesCard from '../../components/EstimatesCard.vue';
import BudgetCard from '../../components/BudgetCard.vue';
import { get, qs } from '../../api.js';
import { ui } from '../../ui.js';
import { typeOf, priorityOf } from '../../meta.js';
import LineChart from '../../components/charts/LineChart.vue';
import BarChart from '../../components/charts/BarChart.vue';
import { COLORS, fmtNum } from '../../components/charts/chart.js';

const project = inject('project');
const data = ref(null);
const error = ref('');
const loading = ref(true);
const sprint = ref('');
const weeks = ref(12);
const unit = ref('points'); // burndown: points or issues

async function load() {
  loading.value = true;
  try {
    data.value = await get(`/api/projects/${project.value.key}/reports?${qs({ sprint: sprint.value, weeks: weeks.value })}`);
    error.value = '';
  } catch (e) {
    error.value = e.message;
  }
  loading.value = false;
}
watch([() => ui.changes, sprint, weeks], load, { immediate: true });

// dates from the API are UTC days
const short = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const signed = (n) => (n > 0 ? `+${fmtNum(n)}` : fmtNum(n));

const burn = computed(() => data.value?.burndown);
const burnChart = computed(() => {
  const b = burn.value;
  if (!b?.days) return null;
  const pts = unit.value === 'points';
  return {
    labels: ['Start', ...b.days.map((d) => short(d.date))],
    series: [
      {
        name: 'Remaining',
        color: COLORS.primary,
        values: [pts ? b.start.points : b.start.issues, ...b.days.map((d) => (pts ? d.remainingPoints : d.remainingIssues))],
      },
      {
        name: 'Ideal',
        color: COLORS.grey,
        dashed: true,
        values: [pts ? b.start.points : b.start.issues, ...b.days.map((d) => (pts ? d.idealPoints : d.idealIssues))],
      },
    ],
  };
});
const showChanges = ref(false);
const changeText = (c) =>
  c.change === 'added' ? 'Added' : c.change === 'removed' ? 'Removed' : `Estimate ${fmtNum(c.from)} to ${fmtNum(c.to)}`;

const velocity = computed(() => {
  const v = data.value?.velocity;
  if (!v?.sprints.length) return null;
  return {
    labels: v.sprints.map((s) => s.sprint.name),
    series: [
      { name: 'Committed', color: COLORS.lightGrey, values: v.sprints.map((s) => s.committedPoints) },
      { name: 'Completed', color: COLORS.primary, values: v.sprints.map((s) => s.completedPoints) },
    ],
  };
});

const flow = computed(() => {
  const f = data.value?.flow;
  if (!f) return null;
  return {
    labels: f.weeks.map((w) => short(w.start)),
    series: [
      { name: 'Created', color: COLORS.primary, values: f.weeks.map((w) => w.created) },
      { name: 'Resolved', color: COLORS.secondary, values: f.weeks.map((w) => w.resolved) },
    ],
  };
});

const cycle = computed(() => data.value?.cycleTime);
const cycleChart = computed(
  () =>
    cycle.value && {
      labels: cycle.value.buckets.map((b) =>
        b.label.replace(' days', 'd').replace(' day', 'd').replace('Under ', '<').replace(' to ', '-').replace(' or more', '+'),
      ),
      series: [{ name: 'Issues', color: COLORS.secondary, values: cycle.value.buckets.map((b) => b.count) }],
    },
);

const breakdown = computed(() => {
  const b = data.value?.breakdown;
  if (!b) return [];
  return [
    {
      title: 'By status',
      rows: b.byStatus.map((s) => ({ label: s.name, count: s.count, color: s.category === 'todo' ? COLORS.lightGrey : COLORS.secondary })),
    },
    {
      title: 'By assignee',
      rows: b.byAssignee.map((a) => ({ label: a.name, count: a.count, color: a.id ? COLORS.primary : COLORS.lightGrey })),
    },
    { title: 'By type', rows: b.byType.map((t) => ({ label: typeOf(t.type).label, count: t.count, color: COLORS.tertiary })) },
    {
      title: 'By priority',
      rows: b.byPriority.map((p) => ({ label: priorityOf(p.priority).label, count: p.count, color: COLORS.quaternary })),
    },
  ];
});
const maxOf = (rows) => Math.max(1, ...rows.map((r) => r.count));
</script>
<template>
  <div class="mx-auto max-w-6xl space-y-4 pb-10">
    <div class="flex flex-wrap items-end gap-3">
      <div class="min-w-0 flex-1">
        <h2 class="text-base font-semibold">Reports</h2>
        <p class="text-xs text-slate-500">Built from issue history. Days and weeks are in UTC.</p>
      </div>
      <label class="w-40">
        <span class="label">Look back</span>
        <select v-model.number="weeks" class="input">
          <option v-for="w in [4, 8, 12, 26, 52]" :key="w" :value="w">{{ w }} weeks</option>
        </select>
      </label>
    </div>

    <p v-if="error" class="card px-4 py-6 text-center text-sm text-red-700">{{ error }}</p>
    <p v-else-if="loading && !data" class="card px-4 py-10 text-center text-sm text-slate-500">Loading reports...</p>

    <template v-else-if="data">
      <!-- burndown -->
      <section class="card p-4" aria-labelledby="r-burn">
        <div class="mb-2 flex flex-wrap items-center gap-2">
          <h3 id="r-burn" class="min-w-0 flex-1 font-semibold">Sprint burndown</h3>
          <div class="flex rounded-full border border-slate-300 p-0.5 text-xs" role="group" aria-label="Measure">
            <button
              v-for="u in ['points', 'issues']"
              :key="u"
              type="button"
              class="rounded-full px-2.5 py-0.5 font-medium"
              :class="unit === u ? 'bg-black text-white' : 'text-slate-600 hover:bg-slate-100'"
              :aria-pressed="unit === u"
              @click="unit = u"
            >
              {{ u === 'points' ? 'Story points' : 'Issues' }}
            </button>
          </div>
          <label class="sr-only" for="r-sprint">Sprint</label>
          <select id="r-sprint" v-model="sprint" class="input w-auto max-w-full">
            <option value="">{{ data.sprints[0]?.state === 'active' ? 'Active sprint' : 'Latest sprint' }}</option>
            <option v-for="s in data.sprints" :key="s.id" :value="s.id">{{ s.name }}{{ s.state === 'active' ? ' (active)' : '' }}</option>
          </select>
        </div>
        <p v-if="burn.empty === 'no_sprint'" class="py-10 text-center text-sm text-slate-500">
          Start a sprint to see a burndown. Plan one on the Backlog tab.
        </p>
        <p v-else-if="burn.empty === 'not_started'" class="py-10 text-center text-sm text-slate-500">
          {{ burn.sprint.name }} has not started yet.
        </p>
        <template v-else>
          <p class="mb-2 text-xs text-slate-500">
            {{ burn.sprint.name }}: {{ short(burn.sprint.startDate) }} to {{ short(burn.sprint.endDate || burn.sprint.startDate)
            }}{{ burn.sprint.state === 'closed' ? ', completed' : '' }}
          </p>
          <dl class="mb-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
            <div class="rounded-md bg-slate-50 px-3 py-2">
              <dt class="text-xs text-slate-500">Committed</dt>
              <dd class="font-semibold tabular-nums">
                {{ unit === 'points' ? fmtNum(burn.totals.committedPoints) : burn.totals.committedIssues }}
              </dd>
            </div>
            <div class="rounded-md bg-slate-50 px-3 py-2">
              <dt class="text-xs text-slate-500">Added</dt>
              <dd class="font-semibold tabular-nums">
                {{ unit === 'points' ? signed(burn.totals.addedPoints) : signed(burn.totals.addedIssues) }}
              </dd>
            </div>
            <div class="rounded-md bg-slate-50 px-3 py-2">
              <dt class="text-xs text-slate-500">Removed</dt>
              <dd class="font-semibold tabular-nums">
                {{ unit === 'points' ? signed(-burn.totals.removedPoints) : signed(-burn.totals.removedIssues) }}
              </dd>
            </div>
            <div class="rounded-md bg-slate-50 px-3 py-2">
              <dt class="text-xs text-slate-500">Completed</dt>
              <dd class="font-semibold tabular-nums">
                {{ unit === 'points' ? fmtNum(burn.totals.completedPoints) : burn.totals.completedIssues }}
              </dd>
            </div>
            <div class="rounded-md bg-slate-50 px-3 py-2">
              <dt class="text-xs text-slate-500">Remaining</dt>
              <dd class="font-semibold tabular-nums">
                {{ unit === 'points' ? fmtNum(burn.totals.remainingPoints) : burn.totals.remainingIssues }}
              </dd>
            </div>
          </dl>
          <LineChart
            :title="`Burndown for ${burn.sprint.name}`"
            :description="`Remaining ${unit === 'points' ? 'story points' : 'issues'} at the end of each day against the ideal line.`"
            :labels="burnChart.labels"
            :series="burnChart.series"
            label-header="Day"
          />
          <p v-if="unit === 'points' && burn.totals.unestimatedIssues" class="mt-1 text-xs text-slate-500">
            {{ burn.totals.unestimatedIssues }} issues in this sprint have no story points and count as 0.
          </p>
          <div class="mt-2">
            <button type="button" class="btn btn-ghost btn-sm" :aria-expanded="showChanges" @click="showChanges = !showChanges">
              Scope changes ({{ burn.scopeChanges.length }})
            </button>
            <div v-if="showChanges" class="mt-1 overflow-x-auto">
              <p v-if="!burn.scopeChanges.length" class="px-2 py-2 text-sm text-slate-500">
                No issues were added, removed or re-estimated after the sprint started.
              </p>
              <table v-else class="w-full min-w-[420px] text-left text-sm">
                <thead class="text-xs text-slate-500">
                  <tr>
                    <th class="px-2 py-1 font-semibold">Day</th>
                    <th class="px-2 py-1 font-semibold">Issue</th>
                    <th class="px-2 py-1 font-semibold">Change</th>
                    <th class="px-2 py-1 text-right font-semibold">Points</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="c in burn.scopeChanges" :key="c.at + c.key + c.change" class="border-t border-slate-100">
                    <td class="whitespace-nowrap px-2 py-1">{{ short(c.date) }}</td>
                    <td class="px-2 py-1">
                      <RouterLink :to="`/browse/${c.key}`" class="link">{{ c.key }}</RouterLink>
                      <span class="text-slate-600">{{ c.title }}</span>
                    </td>
                    <td class="whitespace-nowrap px-2 py-1">{{ changeText(c) }}</td>
                    <td class="px-2 py-1 text-right tabular-nums">{{ c.change === 'removed' ? signed(-c.points) : signed(c.points) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </template>
      </section>

      <div class="grid gap-4 lg:grid-cols-2">
        <!-- velocity -->
        <section class="card min-w-0 p-4" aria-labelledby="r-vel">
          <h3 id="r-vel" class="font-semibold">Velocity</h3>
          <p class="mb-2 text-xs text-slate-500">
            Story points committed at sprint start and completed by sprint end, last {{ data.velocity.sprints.length || 6 }} closed sprints.
          </p>
          <p v-if="!velocity" class="py-10 text-center text-sm text-slate-500">
            Velocity needs closed sprints. Complete a sprint to see it here.
          </p>
          <template v-else>
            <p class="mb-1 text-sm">
              Average completed: <strong class="tabular-nums">{{ fmtNum(data.velocity.averageCompletedPoints) }}</strong> points
            </p>
            <BarChart
              title="Velocity"
              description="Committed and completed story points per sprint."
              :labels="velocity.labels"
              :series="velocity.series"
              label-header="Sprint"
            />
          </template>
        </section>

        <!-- created vs resolved -->
        <section class="card min-w-0 p-4" aria-labelledby="r-flow">
          <h3 id="r-flow" class="font-semibold">Created vs resolved</h3>
          <p class="mb-2 text-xs text-slate-500">
            Issues per week (weeks start on Monday). {{ data.flow.totals.created }} created, {{ data.flow.totals.resolved }} resolved.
          </p>
          <p v-if="!data.flow.totals.created && !data.flow.totals.resolved" class="py-10 text-center text-sm text-slate-500">
            No issues were created or resolved in the last {{ data.weeks }} weeks.
          </p>
          <BarChart
            v-else
            title="Created vs resolved"
            description="Issues created and resolved per week."
            :labels="flow.labels"
            :series="flow.series"
            label-header="Week of"
          />
        </section>

        <!-- cycle time -->
        <section class="card min-w-0 p-4" aria-labelledby="r-cycle">
          <h3 id="r-cycle" class="font-semibold">Cycle time</h3>
          <p class="mb-2 text-xs text-slate-500">
            Days from the first move out of a to-do status (or from creation) to resolved, for issues resolved in the last
            {{ data.weeks }} weeks.
          </p>
          <p v-if="!cycle.issues" class="py-10 text-center text-sm text-slate-500">
            Cycle time needs resolved issues. Move some issues to a done status.
          </p>
          <template v-else>
            <dl class="mb-3 grid grid-cols-3 gap-2 text-sm">
              <div class="rounded-md bg-slate-50 px-3 py-2">
                <dt class="text-xs text-slate-500">Median</dt>
                <dd class="font-semibold tabular-nums">{{ fmtNum(cycle.medianDays) }} days</dd>
              </div>
              <div class="rounded-md bg-slate-50 px-3 py-2">
                <dt class="text-xs text-slate-500">85th percentile</dt>
                <dd class="font-semibold tabular-nums">{{ fmtNum(cycle.p85Days) }} days</dd>
              </div>
              <div class="rounded-md bg-slate-50 px-3 py-2">
                <dt class="text-xs text-slate-500">Issues</dt>
                <dd class="font-semibold tabular-nums">{{ cycle.issues }}</dd>
              </div>
            </dl>
            <BarChart
              title="Cycle time distribution"
              description="Number of resolved issues per cycle time range."
              :labels="cycleChart.labels"
              :series="cycleChart.series"
              :legend="false"
              :height="180"
              label-header="Cycle time"
            />
            <div v-if="cycle.slowest.length" class="mt-2 text-sm">
              <div class="text-xs font-semibold text-slate-600">Slowest</div>
              <ul>
                <li v-for="s in cycle.slowest" :key="s.key" class="flex gap-2 truncate py-0.5">
                  <span class="w-16 shrink-0 text-right tabular-nums text-slate-600">{{ fmtNum(s.days) }} d</span>
                  <RouterLink :to="`/browse/${s.key}`" class="link shrink-0">{{ s.key }}</RouterLink><span
                    class="truncate text-slate-600"
                    >{{ s.title }}</span
                  >
                </li>
              </ul>
            </div>
          </template>
        </section>

        <!-- breakdown -->
        <section class="card min-w-0 p-4" aria-labelledby="r-break">
          <h3 id="r-break" class="font-semibold">Open issues</h3>
          <p class="mb-2 text-xs text-slate-500">{{ data.breakdown.open }} open issues right now.</p>
          <p v-if="!data.breakdown.open" class="py-10 text-center text-sm text-slate-500">No open issues.</p>
          <div v-else class="grid gap-4 sm:grid-cols-2">
            <div v-for="g in breakdown" :key="g.title" class="min-w-0">
              <h4 class="mb-1 text-xs font-semibold text-slate-600">{{ g.title }}</h4>
              <ul class="space-y-1 text-sm">
                <li
                  v-for="r in g.rows"
                  :key="r.label"
                  class="grid grid-cols-[minmax(0,7rem)_1fr_2rem] items-center gap-2"
                  :title="`${r.label}: ${r.count}`"
                >
                  <span class="truncate">{{ r.label }}</span>
                  <span class="h-2.5 rounded-sm bg-slate-100" aria-hidden="true"
                    ><span
                      class="block h-full rounded-sm"
                      :style="{ width: `${(r.count / maxOf(g.rows)) * 100}%`, background: r.color }"
                    ></span
                  ></span>
                  <span class="text-right tabular-nums">{{ r.count }}</span>
                </li>
              </ul>
            </div>
          </div>
        </section>
        <BudgetCard v-if="!project.guest" :project-key="project.key" />
        <EstimatesCard :project-key="project.key" />
      </div>

      <details class="text-xs text-slate-500">
        <summary class="cursor-pointer font-semibold text-slate-600">How these are worked out</summary>
        <ul class="mt-1 list-disc space-y-0.5 pl-5">
          <li>
            Past state comes from issue history. An issue's story points on a given day are its current points unless its history shows a
            change. Issues without points count as 0.
          </li>
          <li>
            Committed means in the sprint when it started. Added and removed are sprint changes after that. Completed means in a done status
            when the sprint was completed (or now, for the active sprint).
          </li>
          <li>
            Sprints are matched by name in the history, so renaming a sprint later can hide its past scope. Renamed or deleted statuses fall
            back to the resolved date.
          </li>
          <li>Deleted issues are not counted. An issue resolved twice counts in the week of its last resolution.</li>
        </ul>
      </details>
    </template>
  </div>
</template>
