<script setup>
// /portfolio: every project the viewer can see with its health, progress, risks and dates (GET /api/portfolio).
// Filters and sorting run here (src/portfolio.js) and live in the URL query, so a filtered view can be shared.
import { ref, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { get, session } from '../api.js';
import { downloadText, copyText } from '../browser.js';
import { day } from '../statusReport.js';
import {
  HEALTH,
  healthLabel,
  healthText,
  columnsFor,
  filterRows,
  sortRows,
  leadsOf,
  filtersFromQuery,
  queryFromFilters,
  toCsv,
  daysText,
} from '../portfolio.js';

const route = useRoute();
const router = useRouter();
const data = ref(null);
const error = ref('');
const loading = ref(false);
const f = ref(filtersFromQuery(route.query));

async function load() {
  loading.value = true;
  error.value = '';
  try {
    data.value = await get(`/api/portfolio${f.value.archived ? '?archived=1' : ''}`);
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}
load();

// keep the URL in step with the filters (replace: no history entry per keystroke)
watch(f, (v) => router.replace({ query: queryFromFilters(v) }), { deep: true });
watch(() => f.value.archived, load);
watch(
  () => route.query,
  (q) => {
    const next = filtersFromQuery(q);
    if (JSON.stringify(next) !== JSON.stringify(f.value)) f.value = next;
  },
);

const guest = computed(() => session.user?.role === 'guest');
const budgetShown = computed(() => Boolean(data.value?.budgetShown) && !guest.value);
const columns = computed(() => columnsFor(budgetShown.value));
const rows = computed(() => (data.value ? sortRows(filterRows(data.value.rows, f.value), f.value.sort, f.value.dir) : []));
const leads = computed(() => (data.value ? leadsOf(data.value.rows) : []));
const s = computed(() => data.value?.summary || {});
const filtered = computed(() => Boolean(f.value.q || f.value.lead || f.value.health || f.value.mine));

function sortBy(id) {
  if (f.value.sort === id) f.value.dir = f.value.dir === 'asc' ? 'desc' : 'asc';
  else {
    f.value.sort = id;
    f.value.dir = ['name', 'lead', 'milestone', 'sprint'].includes(id) ? 'asc' : 'desc';
  }
}
const ariaSort = (id) => (f.value.sort === id ? (f.value.dir === 'asc' ? 'ascending' : 'descending') : 'none');
function toggleHealth(h) {
  f.value.health = f.value.health === h ? '' : h;
}
function clearFilters() {
  f.value = { ...f.value, q: '', lead: '', health: '', mine: false };
}

const exportCsv = () =>
  downloadText(`portfolio-${data.value?.today || 'today'}.csv`, toCsv(rows.value, { budgetShown: budgetShown.value }), 'text/csv');
const copyLink = () => copyText(location.href, { ok: 'Link copied', fail: 'Could not copy the link' });

// Milestones strip: position of a date in the next 90 days
const horizon = 90;
const pos = (m) => `${Math.min(100, Math.max(0, (m.daysLeft / horizon) * 100))}%`;
const monthTicks = computed(() => {
  if (!data.value) return [];
  const start = Date.parse(`${data.value.today}T00:00:00Z`);
  const out = [];
  const d = new Date(start);
  d.setUTCDate(1);
  for (let i = 0; i < 4; i++) {
    d.setUTCMonth(d.getUTCMonth() + 1);
    const n = Math.round((d.getTime() - start) / 864e5);
    if (n > 0 && n < horizon) out.push({ n, label: d.toLocaleString('en', { month: 'short', timeZone: 'UTC' }) });
  }
  return out;
});
const openMilestone = (m) => router.push(`/projects/${m.project.key}/releases/${m.id}`);
const lastActivity = (r) => (r.lastActivity ? day(r.lastActivity.slice(0, 10)) : '');
const tileCls = (on) => (on ? 'border-black ring-2 ring-accent/40' : 'border-slate-200 hover:border-slate-400');
</script>

<template>
  <div>
    <div class="mb-4 flex flex-wrap items-center gap-2">
      <h1 class="mr-auto text-xl font-semibold">Portfolio</h1>
      <button class="btn btn-sm" @click="copyLink">Copy link</button>
      <button class="btn btn-sm" :disabled="!rows.length" @click="exportCsv">Export CSV</button>
    </div>

    <p v-if="error" class="mb-3 text-sm text-red-700" role="alert">{{ error }}</p>

    <!-- summary tiles -->
    <section v-if="data" aria-label="Summary" class="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
      <button
        v-for="h in ['green', 'amber', 'red']"
        :key="h"
        class="card flex items-center gap-2 border p-3 text-left"
        :class="tileCls(f.health === h)"
        :aria-pressed="f.health === h"
        @click="toggleHealth(h)"
      >
        <span class="h-3 w-3 shrink-0 rounded-full border" :class="HEALTH[h].cls" aria-hidden="true"></span>
        <span
          ><span class="block text-xl font-semibold">{{ s[h] }}</span
          ><span class="text-xs text-slate-600">{{ HEALTH[h].label }}</span></span
        >
      </button>
      <button
        class="card flex items-center gap-2 border p-3 text-left"
        :class="tileCls(f.health === 'none')"
        :aria-pressed="f.health === 'none'"
        @click="toggleHealth('none')"
      >
        <span class="h-3 w-3 shrink-0 rounded-full border border-slate-500 bg-slate-100" aria-hidden="true"></span>
        <span
          ><span class="block text-xl font-semibold">{{ s.noReport }}</span
          ><span class="text-xs text-slate-600">No report</span></span
        >
      </button>
      <div class="card p-3">
        <span class="block text-xl font-semibold" :class="s.overdue ? 'text-red-700' : ''">{{ s.overdue }}</span><span
          class="text-xs text-slate-600"
          >Overdue issues</span
        >
      </div>
      <div class="card p-3">
        <span class="block text-xl font-semibold" :class="s.blocked ? 'text-amber-800' : ''">{{ s.blocked }}</span><span
          class="text-xs text-slate-600"
          >Blocked issues</span
        >
      </div>
      <div class="card p-3">
        <span class="block text-xl font-semibold">{{ s.milestonesSoon }}</span><span class="text-xs text-slate-600"
          >Milestones in the next 14 days</span
        >
      </div>
    </section>

    <!-- milestones in the next 90 days -->
    <section v-if="data" class="card mb-4 p-3" aria-labelledby="pf-ms">
      <h2 id="pf-ms" class="mb-2 text-sm font-semibold">Milestones in the next 90 days</h2>
      <p v-if="!data.milestones.length" class="text-sm text-slate-600">No releases with a date in the next 90 days.</p>
      <template v-else>
        <div class="relative mx-2 mb-2 hidden h-10 sm:block" aria-hidden="true">
          <div class="absolute inset-x-0 top-5 h-px bg-slate-300"></div>
          <div
            v-for="t in monthTicks"
            :key="t.n"
            class="absolute top-0 h-10 border-l border-dashed border-slate-300 pl-1 text-[11px] text-slate-600"
            :style="{ left: pos({ daysLeft: t.n }) }"
          >
            {{ t.label }}
          </div>
          <div
            v-for="m in data.milestones"
            :key="m.id"
            class="absolute top-[14px] h-3 w-3 -translate-x-1/2 rotate-45 cursor-pointer border border-black bg-accent hover:bg-accent"
            :style="{ left: pos(m) }"
            :title="`${m.name} (${m.project.key}), ${day(m.date)}`"
            @click="openMilestone(m)"
          ></div>
        </div>
        <ul class="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <li v-for="m in data.milestones" :key="m.id">
            <RouterLink :to="`/projects/${m.project.key}/releases/${m.id}`" class="link">{{ m.name }}</RouterLink>
            <span class="text-slate-600"> {{ m.project.key }}, {{ day(m.date) }} ({{ daysText(m.daysLeft) }})</span>
          </li>
        </ul>
      </template>
    </section>

    <!-- filters -->
    <div class="mb-3 flex flex-wrap items-end gap-3" role="search" aria-label="Filter projects">
      <div class="w-full sm:w-56">
        <label class="label" for="pf-q">Project</label><input id="pf-q" v-model="f.q" class="input" placeholder="Name or key" />
      </div>
      <div class="w-[calc(50%-0.375rem)] sm:w-44">
        <label class="label" for="pf-lead">Lead</label>
        <select id="pf-lead" v-model="f.lead" class="input">
          <option value="">Any lead</option>
          <option value="none">No lead</option>
          <option v-for="l in leads" :key="l.id" :value="l.id">{{ l.name }}</option>
        </select>
      </div>
      <div class="w-[calc(50%-0.375rem)] sm:w-40">
        <label class="label" for="pf-health">Health</label>
        <select id="pf-health" v-model="f.health" class="input">
          <option value="">Any</option>
          <option value="green">Green</option>
          <option value="amber">Amber</option>
          <option value="red">Red</option>
          <option value="none">No report</option>
        </select>
      </div>
      <label class="flex items-center gap-1.5 pb-1.5 text-sm"><input v-model="f.mine" type="checkbox" /> My projects</label>
      <label class="flex items-center gap-1.5 pb-1.5 text-sm"><input v-model="f.archived" type="checkbox" /> Show archived</label>
      <button v-if="filtered" class="btn btn-ghost btn-sm mb-1" @click="clearFilters">Clear filters</button>
      <span class="mb-1.5 ml-auto text-xs text-slate-600" role="status">{{
        loading ? 'Loading' : data ? `${rows.length} of ${data.rows.length} projects` : ''
      }}</span>
    </div>

    <p v-if="data && !rows.length" class="card px-3 py-10 text-center text-sm text-slate-600">
      {{ data.rows.length ? 'No projects match these filters.' : 'No projects to show.' }}
    </p>

    <!-- table: large screens -->
    <div v-if="rows.length" class="card hidden overflow-x-auto lg:block">
      <table class="w-full text-sm">
        <caption class="sr-only">
          Projects with health, progress and dates. Column headers sort the table.
        </caption>
        <thead class="bg-slate-50 text-left text-xs uppercase text-slate-600">
          <tr>
            <th v-for="c in columns" :key="c.id" scope="col" class="whitespace-nowrap px-2 py-2 font-semibold" :aria-sort="ariaSort(c.id)">
              <button class="inline-flex items-center gap-1 uppercase hover:text-black" @click="sortBy(c.id)">
                {{ c.label }}<span aria-hidden="true">{{ f.sort === c.id ? (f.dir === 'asc' ? '▲' : '▼') : '' }}</span>
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id" class="border-t border-slate-100 align-top">
            <td class="px-2 py-2">
              <RouterLink :to="`/projects/${r.key}/board`" class="link font-medium">{{ r.name }}</RouterLink>
              <div class="text-xs text-slate-600">
                {{ r.key }}<span v-if="r.archived" class="chip ml-1 bg-slate-100 text-slate-700">Archived</span>
              </div>
            </td>
            <td class="px-2 py-2">{{ r.lead?.name || '' }}<span v-if="!r.lead" class="text-slate-500">None</span></td>
            <td class="px-2 py-2">
              <template v-if="r.health.source === 'report'">
                <RouterLink
                  :to="`/projects/${r.key}/status/${r.health.reportId}`"
                  class="chip border"
                  :class="HEALTH[r.health.value]?.cls"
                  :aria-label="`${healthText(r.health)}, open the report`"
                  >{{ healthLabel(r.health) }}</RouterLink
                >
                <div class="text-xs text-slate-600">to {{ day(r.health.periodEnd) }}</div>
              </template>
              <template v-else>
                <div class="text-xs text-slate-600">No report</div>
                <span class="chip border border-dashed" :class="HEALTH[r.health.value]?.cls" :title="r.health.why.join('. ')"
                  >Computed: {{ healthLabel(r.health) }}</span
                >
              </template>
            </td>
            <td class="px-2 py-2 whitespace-nowrap">
              <template v-if="r.done.pct !== null">
                <span class="font-medium">{{ r.done.pct }}%</span>
                <span class="text-xs text-slate-600">({{ r.done.issues }}/{{ r.done.total }})</span>
                <div class="mt-1 h-1.5 w-20 rounded-full bg-slate-200" aria-hidden="true">
                  <div class="h-1.5 rounded-full bg-link" :style="{ width: `${r.done.pct}%` }"></div>
                </div>
                <div v-if="r.done.pointsPct !== null" class="text-xs text-slate-600">{{ r.done.pointsPct }}% of points</div>
              </template>
              <span v-else class="text-slate-500">No issues</span>
            </td>
            <td class="px-2 py-2">{{ r.open }}</td>
            <td class="px-2 py-2">
              <span :class="r.overdue ? 'font-semibold text-red-700' : ''">{{ r.overdue }}</span>
            </td>
            <td class="px-2 py-2">
              <span :class="r.blocked ? 'font-semibold text-amber-800' : ''">{{ r.blocked }}</span>
            </td>
            <td class="px-2 py-2">
              <span :class="r.highBugs ? 'font-semibold text-red-700' : ''">{{ r.highBugs }}</span>
            </td>
            <td class="px-2 py-2">
              <template v-if="r.nextMilestone">
                <RouterLink :to="`/projects/${r.key}/releases/${r.nextMilestone.id}`" class="link">{{ r.nextMilestone.name }}</RouterLink>
                <div class="text-xs" :class="r.nextMilestone.overdue ? 'font-semibold text-red-700' : 'text-slate-600'">
                  {{ day(r.nextMilestone.date) }}, {{ daysText(r.nextMilestone.daysLeft) }}
                </div>
              </template>
              <span v-else class="text-slate-500">None</span>
            </td>
            <td class="px-2 py-2">
              <template v-if="r.activeSprint"
                >{{ r.activeSprint.name }}
                <div class="text-xs text-slate-600">{{ daysText(r.activeSprint.daysLeft) || 'No end date' }}</div></template
              >
              <span v-else class="text-slate-500">None</span>
            </td>
            <td v-if="budgetShown" class="px-2 py-2">
              <span
                v-if="r.budget?.usedPct !== null && r.budget?.usedPct !== undefined"
                :class="
                  r.budget.usedPct >= 100 ? 'font-semibold text-red-700' : r.budget.usedPct >= 80 ? 'font-semibold text-amber-800' : ''
                "
                >{{ r.budget.usedPct }}%</span
              >
              <span v-else-if="r.budget" class="text-slate-600">Set</span>
              <span v-else class="text-slate-500">None</span>
            </td>
            <td class="whitespace-nowrap px-2 py-2 text-slate-700">{{ lastActivity(r) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- cards: small screens -->
    <div v-if="rows.length" class="lg:hidden">
      <div class="mb-2 flex items-center gap-2">
        <label class="label mb-0" for="pf-sort">Sort by</label>
        <select id="pf-sort" v-model="f.sort" class="input w-auto">
          <option v-for="c in columns" :key="c.id" :value="c.id">{{ c.label }}</option>
        </select>
        <button
          class="btn btn-sm"
          :aria-label="f.dir === 'asc' ? 'Sorted ascending, switch to descending' : 'Sorted descending, switch to ascending'"
          @click="f.dir = f.dir === 'asc' ? 'desc' : 'asc'"
        >
          {{ f.dir === 'asc' ? 'Ascending' : 'Descending' }}
        </button>
      </div>
      <ul class="grid gap-2 sm:grid-cols-2">
        <li v-for="r in rows" :key="r.id" class="card p-3 text-sm">
          <div class="flex items-start gap-2">
            <div class="min-w-0 flex-1">
              <RouterLink :to="`/projects/${r.key}/board`" class="link font-medium">{{ r.name }}</RouterLink>
              <div class="text-xs text-slate-600">
                {{ r.key }}<template v-if="r.lead">, lead {{ r.lead.name }}</template
                ><span v-if="r.archived" class="chip ml-1 bg-slate-100 text-slate-700">Archived</span>
              </div>
            </div>
            <RouterLink
              v-if="r.health.source === 'report'"
              :to="`/projects/${r.key}/status/${r.health.reportId}`"
              class="chip shrink-0 border"
              :class="HEALTH[r.health.value]?.cls"
              :aria-label="`${healthText(r.health)}, open the report`"
              >{{ healthLabel(r.health) }}</RouterLink
            >
            <span v-else class="chip shrink-0 border border-dashed" :class="HEALTH[r.health.value]?.cls"
              >No report, computed: {{ healthLabel(r.health) }}</span
            >
          </div>
          <dl class="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <div>
              <dt class="inline text-slate-600">Done:</dt>
              <dd class="inline">{{ r.done.pct === null ? 'No issues' : `${r.done.pct}% (${r.done.issues}/${r.done.total})` }}</dd>
            </div>
            <div>
              <dt class="inline text-slate-600">Open:</dt>
              <dd class="inline">{{ r.open }}</dd>
            </div>
            <div>
              <dt class="inline text-slate-600">Overdue:</dt>
              <dd class="inline" :class="r.overdue ? 'font-semibold text-red-700' : ''">{{ r.overdue }}</dd>
            </div>
            <div>
              <dt class="inline text-slate-600">Blocked:</dt>
              <dd class="inline" :class="r.blocked ? 'font-semibold text-amber-800' : ''">{{ r.blocked }}</dd>
            </div>
            <div>
              <dt class="inline text-slate-600">High bugs:</dt>
              <dd class="inline">{{ r.highBugs }}</dd>
            </div>
            <div v-if="budgetShown">
              <dt class="inline text-slate-600">Budget used:</dt>
              <dd class="inline">
                {{ r.budget?.usedPct ?? (r.budget ? 'Set' : 'None')
                }}{{ r.budget?.usedPct !== null && r.budget?.usedPct !== undefined ? '%' : '' }}
              </dd>
            </div>
            <div class="col-span-2">
              <dt class="inline text-slate-600">Next milestone:</dt>
              <dd class="inline">
                <template v-if="r.nextMilestone"
                  ><RouterLink :to="`/projects/${r.key}/releases/${r.nextMilestone.id}`" class="link">{{
                    r.nextMilestone.name
                  }}</RouterLink>
                  <span :class="r.nextMilestone.overdue ? 'font-semibold text-red-700' : ''"
                    >{{ day(r.nextMilestone.date) }}, {{ daysText(r.nextMilestone.daysLeft) }}</span
                  ></template
                >
                <template v-else>None</template>
              </dd>
            </div>
            <div class="col-span-2">
              <dt class="inline text-slate-600">Sprint:</dt>
              <dd class="inline">
                {{
                  r.activeSprint
                    ? `${r.activeSprint.name}${r.activeSprint.daysLeft !== null ? `, ${daysText(r.activeSprint.daysLeft)}` : ''}`
                    : 'None'
                }}
              </dd>
            </div>
            <div class="col-span-2">
              <dt class="inline text-slate-600">Last activity:</dt>
              <dd class="inline">{{ lastActivity(r) }}</dd>
            </div>
          </dl>
        </li>
      </ul>
    </div>

    <p class="mt-3 text-xs text-slate-600">
      Health is the Overall RAG of the latest published status report. Without one, the page computes it with the same rules from overdue
      and blocked issues, releases past their date, high priority bugs<template v-if="!guest"> and hours against estimates</template>, and
      marks it "computed". <RouterLink to="/help#portfolio" class="link">How it works</RouterLink>
    </p>
  </div>
</template>
