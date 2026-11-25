<script setup>
// Capacity: people x the next 8 weeks, booked / available hours (server/lib/capacity.js). Not for guests.
import { ref, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { get } from '../api.js';
import { fmtDate } from '../meta.js';
import { fmtHours } from '../dates.js';
import { projectList } from '../projects.js';
import Avatar from '../components/Avatar.vue';
import Modal from '../components/Modal.vue';
import TypeIcon from '../components/TypeIcon.vue';
import CapacityEditor from '../components/CapacityEditor.vue';
import { useLoad } from '../composables/useLoad.js';
import LoadState from '../components/LoadState.vue';
import { plural } from '../plural.js';

const route = useRoute();
const router = useRouter();
const projects = ref([]);
const cell = ref(null); // { person, week (or null = unscheduled) }
const editing = ref(null); // person row (admins: anyone; everyone: themselves)
const showMine = ref(false);

const LEVELS = {
  none: { word: 'No hours', cls: 'bg-white text-slate-600 border border-slate-200' },
  light: { word: 'Light', cls: 'bg-slate-100 text-slate-800' },
  good: { word: 'Good', cls: 'bg-green-100 text-green-900' },
  over: { word: 'Over', cls: 'bg-amber-100 text-amber-950' },
  overloaded: { word: 'Overloaded', cls: 'bg-red-100 text-red-900' },
};
const query = computed(() => ({ project: String(route.query.project || ''), team: String(route.query.team || '') }));
const qs = () => new URLSearchParams(Object.entries(query.value).filter(([, v]) => v)).toString();

const { data, loading, error: loadError, reload: load } = useLoad(() => get(`/api/capacity?${qs()}`), query);
projectList()
  .then((list) => (projects.value = list))
  .catch(() => {});
const go = (q) => router.replace({ query: Object.fromEntries(Object.entries({ ...route.query, ...q }).filter(([, v]) => v)) });

const fmt = (h) => fmtHours(h, 1);
const weekLabel = (w) =>
  new Date(`${w.start}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const csvHref = computed(() => `/api/capacity/export.csv?${qs()}`);
const lvl = (w) => LEVELS[w.level] || LEVELS.none;
const pctText = (w) => (w.pct === null ? (w.booked > 0 ? 'no hours free' : '') : `${w.pct}%`);
const cellIssues = computed(() => {
  if (!cell.value) return [];
  const { person, week } = cell.value;
  return person.issues.map((i) => ({ ...i, hours: week ? i.weeks[week.start] || 0 : i.unscheduled })).filter((i) => i.hours > 0);
});
const cellElsewhere = computed(() => {
  const e = cell.value?.person.elsewhere;
  if (!e) return 0;
  return cell.value.week ? e.weeks[cell.value.week.start] || 0 : e.unscheduled;
});
const cellAway = computed(() => {
  if (!cell.value?.week) return [];
  const start = cell.value.week.start;
  const end = cell.value.week.end;
  return cell.value.person.timeOff.filter((t) => t.startDate <= end && t.endDate >= start);
});
const me = computed(() => data.value?.people.find((p) => p.isMe));
const onChanged = () => load();
</script>

<template>
  <div class="mb-4 flex flex-wrap items-center gap-2">
    <h1 class="mr-2 text-xl font-semibold">Capacity</h1>
    <div class="ml-auto flex w-full flex-wrap items-end gap-2 sm:w-auto">
      <div class="min-w-0 flex-1 sm:flex-none">
        <label class="label" for="cap-project">Work from</label>
        <select id="cap-project" :value="query.project" class="input py-1 sm:w-48" @change="go({ project: $event.target.value })">
          <option value="">All projects</option>
          <option v-for="p in projects" :key="p.key" :value="p.key">{{ p.key }} {{ p.name }}</option>
        </select>
      </div>
      <div class="min-w-0 flex-1 sm:flex-none">
        <label class="label" for="cap-team">People</label>
        <select id="cap-team" :value="query.team" class="input py-1 sm:w-48" @change="go({ team: $event.target.value })">
          <option value="">
            {{ query.project ? `Members of ${query.project}` : data?.isAdmin ? 'Everyone' : 'Everyone I share a project with' }}
          </option>
          <option v-for="p in projects" :key="p.key" :value="p.key">Members of {{ p.key }}</option>
        </select>
      </div>
      <a class="btn btn-sm" :href="csvHref" download>Export CSV</a>
    </div>
  </div>

  <p class="mb-3 text-sm text-slate-600">
    Booked hours are what is left on open issues (estimate minus time logged), spread over the weekdays up to the due date or the end of the
    sprint.
    <template v-if="data?.project">Available hours are each person's share of their time for {{ data.project.key }}.</template>
  </p>

  <LoadState v-if="!data" :loading="loading" :error="loadError" card :rows="5" @retry="load" />
  <template v-else-if="data">
    <ul class="mb-3 flex flex-wrap gap-2 text-xs" aria-label="Legend">
      <li class="chip bg-slate-100 text-slate-800">Light: under 70%</li>
      <li class="chip bg-green-100 text-green-900">Good: 70 to 100%</li>
      <li class="chip bg-amber-100 text-amber-950">Over: above 100%</li>
      <li class="chip bg-red-100 text-red-900">Overloaded: above 120%</li>
      <li class="chip border border-dashed border-slate-500 bg-white text-slate-700">Away: time off that week</li>
    </ul>
    <p v-if="data.truncated" class="mb-2 text-sm text-amber-950">
      Showing the first people only. Choose a project or team to see the rest.
    </p>

    <div class="card overflow-x-auto">
      <table class="w-full min-w-[56rem] border-separate border-spacing-0 text-sm">
        <caption class="sr-only">
          Booked and available hours per person and week
        </caption>
        <thead class="bg-slate-50 text-xs text-slate-600">
          <tr>
            <th scope="col" class="sticky left-0 z-10 bg-slate-50 px-3 py-2 text-left">Person</th>
            <th v-for="w in data.weeks" :key="w.start" scope="col" class="px-1 py-2 text-center font-medium">
              <span :class="w.start <= data.today && data.today <= w.end ? 'font-bold text-black' : ''">{{ weekLabel(w) }}</span>
            </th>
            <th scope="col" class="px-2 py-2 text-center font-medium">Unscheduled</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in data.people" :key="p.id">
            <th scope="row" class="sticky left-0 z-10 border-t border-slate-100 bg-white px-3 py-1.5 text-left font-normal">
              <div class="flex min-w-[9rem] items-center gap-2">
                <Avatar :user="p" :size="22" />
                <div class="min-w-0">
                  <button
                    v-if="p.canEdit"
                    class="block max-w-[10rem] truncate text-left font-medium hover:underline"
                    :title="`Edit ${p.name}'s hours and time off`"
                    @click="editing = p"
                  >
                    {{ p.name }}
                  </button>
                  <span v-else class="block max-w-[10rem] truncate font-medium">{{ p.name }}</span>
                  <span class="block text-xs text-slate-600">
                    {{ fmt(p.weeklyHours) }} h/week<template v-if="data.project">
                      · {{ fmt(p.share) }}%{{ p.shareSet ? '' : ' (not allocated)' }}</template
                    >
                  </span>
                </div>
              </div>
            </th>
            <td v-for="w in p.weeks" :key="w.start" class="border-t border-slate-100 px-1 py-1">
              <button
                class="relative block w-full min-w-[5.5rem] rounded-md px-1.5 py-1 text-left leading-tight hover:ring-2 hover:ring-black focus-visible:ring-2 focus-visible:ring-black"
                :class="[lvl(w).cls, w.awayDays ? 'outline-2 outline-dashed outline-slate-500 -outline-offset-2' : '']"
                @click="cell = { person: p, week: w }"
              >
                <span class="sr-only">{{ p.name }}, week of {{ weekLabel(w) }}: </span>
                <span class="block font-semibold">{{ fmt(w.booked) }} / {{ fmt(w.available) }} h<span class="sr-only"> booked</span></span>
                <span class="block text-xs">{{ pctText(w) }} {{ lvl(w).word }}</span>
                <span v-if="w.awayDays" class="block text-xs font-medium">Away {{ w.awayDays }} d</span>
                <span class="sr-only">. Show issues.</span>
              </button>
            </td>
            <td class="border-t border-slate-100 px-1 py-1 text-center">
              <button
                v-if="p.unscheduled || p.later"
                class="w-full rounded-md px-1.5 py-1 text-xs hover:bg-slate-100"
                :aria-label="`${p.name}: ${fmt(p.unscheduled)} hours unscheduled. Show issues.`"
                @click="cell = { person: p, week: null }"
              >
                <span class="block font-semibold">{{ fmt(p.unscheduled) }} h</span>
                <span v-if="p.later" class="block text-slate-600">+{{ fmt(p.later) }} h later</span>
              </button>
              <span v-else class="text-slate-600">0</span>
            </td>
          </tr>
          <tr v-if="!data.people.length">
            <td :colspan="data.weeks.length + 2" class="px-3 py-10 text-center text-slate-600">Nobody to show.</td>
          </tr>
        </tbody>
        <tfoot v-if="data.people.length > 1" class="font-semibold">
          <tr>
            <th scope="row" class="sticky left-0 z-10 border-t-2 border-slate-200 bg-white px-3 py-2 text-left">Total</th>
            <td v-for="t in data.totals" :key="t.start" class="border-t-2 border-slate-200 px-2 py-2 text-xs">
              {{ fmt(t.booked) }} / {{ fmt(t.available) }} h
            </td>
            <td class="border-t-2 border-slate-200 px-2 py-2 text-center text-xs">{{ fmt(data.unscheduled) }} h</td>
          </tr>
        </tfoot>
      </table>
    </div>

    <section v-if="me" class="card mt-4 p-4" aria-labelledby="cap-mine">
      <div class="flex flex-wrap items-center gap-2">
        <h2 id="cap-mine" class="text-sm font-semibold">My availability</h2>
        <span class="text-xs text-slate-600"
          >{{ fmt(me.weeklyHours) }} hours a week, {{ me.timeOff.length }} time-off {{ plural(me.timeOff.length, 'entry', 'entries') }} in
          these weeks</span
        >
        <button class="btn btn-sm ml-auto" :aria-expanded="showMine" @click="showMine = !showMine">
          {{ showMine ? 'Close' : 'Change' }}
        </button>
      </div>
      <CapacityEditor v-if="showMine" class="mt-3" user-id="me" @changed="onChanged" />
    </section>
  </template>

  <Modal
    v-if="cell"
    :title="cell.week ? `${cell.person.name}, week of ${weekLabel(cell.week)}` : `${cell.person.name}, unscheduled`"
    wide
    @close="cell = null"
  >
    <p v-if="cell.week" class="mb-3 text-sm">
      {{ fmt(cell.week.booked) }} of {{ fmt(cell.week.available) }} hours booked<template v-if="cell.week.pct !== null">
        ({{ cell.week.pct }}%)</template
      >: {{ lvl(cell.week).word }}.
    </p>
    <p v-else class="mb-3 text-sm text-slate-600">
      Open issues with an estimate but no due date and no sprint dates.<template v-if="cell.person.later">
        {{ fmt(cell.person.later) }} more hours fall after the weeks shown.</template
      >
    </p>
    <ul v-if="cellAway.length" class="mb-3 space-y-1 text-sm">
      <li v-for="t in cellAway" :key="t.startDate + t.endDate">
        <strong>Away</strong> {{ fmtDate(t.startDate) }}<template v-if="t.endDate !== t.startDate"> to {{ fmtDate(t.endDate) }}</template
        ><template v-if="t.note">: {{ t.note }}</template>
      </li>
    </ul>
    <ul v-if="cellIssues.length" class="divide-y divide-slate-100 text-sm">
      <li v-for="i in cellIssues" :key="i.key" class="flex flex-wrap items-center gap-2 py-1.5">
        <RouterLink :to="`/browse/${i.key}`" class="flex min-w-0 flex-1 items-center gap-2 hover:underline" @click="cell = null">
          <TypeIcon :type="i.type" /><span class="shrink-0 font-medium text-slate-600">{{ i.key }}</span
          ><span class="truncate">{{ i.title }}</span>
        </RouterLink>
        <span class="text-xs text-slate-600"
          >{{ i.dueDate ? `due ${fmtDate(i.dueDate)}` : 'no due date' }}, {{ fmt(i.remaining) }} h left</span
        >
        <span class="w-14 text-right font-semibold">{{ fmt(i.hours) }} h</span>
      </li>
    </ul>
    <p v-else-if="!cellElsewhere" class="text-sm text-slate-600">No booked work here.</p>
    <p v-if="cellElsewhere" class="mt-2 text-sm text-slate-600">{{ fmt(cellElsewhere) }} h on issues in projects you cannot see.</p>
    <p v-if="cell.person.unestimated" class="mt-2 text-xs text-slate-600">
      {{ cell.person.unestimated }} open {{ plural(cell.person.unestimated, 'issue has', 'issues have') }} no estimate and
      {{ plural(cell.person.unestimated, 'is', 'are') }} not counted.
    </p>
  </Modal>

  <Modal v-if="editing" :title="editing.isMe ? 'My availability' : `${editing.name}: hours and time off`" wide @close="editing = null">
    <CapacityEditor :user-id="editing.isMe ? 'me' : editing.id" @changed="onChanged" />
  </Modal>
</template>
