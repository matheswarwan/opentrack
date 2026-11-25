<script setup>
// One dashboard: a grid of saved reports (half or full width). The owner can add, remove, reorder,
// resize, rename and share. Each report is worked out as the viewer.
import { ref, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { get, patch, del, toast } from '../../api.js';
import { kindOf } from '../../reports.js';
import Modal from '../../components/Modal.vue';
import ReportCard from '../../components/reports/ReportCard.vue';
import { attempt } from '../../composables/useAction.js';

const route = useRoute();
const router = useRouter();
const dash = ref(null);
const error = ref('');
const renaming = ref(null);
const adding = ref(false);
const allReports = ref([]);
const saving = ref(false);

async function load() {
  try {
    dash.value = (await get(`/api/dashboards/${route.params.id}`)).dashboard;
    error.value = '';
  } catch (e) {
    error.value = e.message;
  }
}
watch(
  () => route.params.id,
  (id) => {
    if (id) load();
  },
  { immediate: true },
);

async function save(changes) {
  saving.value = true;
  await attempt(async () => {
    const body = { ...changes };
    if (body.layout) body.layout = body.layout.map((x) => ({ reportId: x.reportId, width: x.width }));
    const d = (await patch(`/api/dashboards/${dash.value.id}`, body)).dashboard;
    // keep the loaded report details; only the order, widths, name or sharing changed
    const byId = new Map(dash.value.layout.map((x) => [x.reportId, x.report]));
    for (const x of changes.layout || []) if (x.report) byId.set(x.reportId, x.report);
    dash.value = { ...d, layout: d.layout.map((x) => ({ ...x, report: byId.get(x.reportId) ?? null })) };
  });
  saving.value = false;
}
function move(i, dir) {
  const l = [...dash.value.layout];
  const [x] = l.splice(i, 1);
  l.splice(i + dir, 0, x);
  save({ layout: l });
}
const setWidth = (i, width) => save({ layout: dash.value.layout.map((x, j) => (j === i ? { ...x, width } : x)) });
const remove = (i) => save({ layout: dash.value.layout.filter((_, j) => j !== i) });

async function openAdd() {
  adding.value = true;
  allReports.value = (await get('/api/saved-reports')).reports;
}
const onDash = computed(() => new Set((dash.value?.layout || []).map((x) => x.reportId)));
function add(r) {
  adding.value = false;
  save({
    layout: [
      ...dash.value.layout,
      { reportId: r.id, width: r.kind === 'list' || r.kind === 'createdVsResolved' ? 'full' : 'half', report: r },
    ],
  });
}
async function rename() {
  await save({ name: renaming.value });
  renaming.value = null;
}
async function removeDashboard() {
  if (!confirm(`Delete the dashboard "${dash.value.name}"? Its reports are kept.`)) return;
  await attempt(async () => {
    await del(`/api/dashboards/${dash.value.id}`);
    toast('Dashboard deleted');
    router.push('/reports');
  });
}
</script>
<template>
  <div class="mx-auto max-w-6xl space-y-4 pb-10">
    <p v-if="error" class="card px-4 py-6 text-center text-sm text-red-700">
      {{ error }} <RouterLink to="/reports" class="link">Back to reports</RouterLink>
    </p>
    <p v-else-if="!dash" class="card px-4 py-10 text-center text-sm text-slate-500">Loading...</p>
    <template v-else>
      <div class="flex flex-wrap items-end gap-3">
        <div class="min-w-0 flex-1">
          <RouterLink to="/reports" class="text-xs text-slate-500 hover:underline">Reports</RouterLink>
          <form v-if="renaming !== null" class="mt-1 flex flex-wrap gap-2" @submit.prevent="rename">
            <label class="sr-only" for="dash-rename">Dashboard name</label>
            <input id="dash-rename" v-model="renaming" class="input max-w-xs" maxlength="100" required autofocus />
            <button type="submit" class="btn btn-sm btn-primary" :disabled="saving || !renaming.trim()">Save</button>
            <button type="button" class="btn btn-sm" @click="renaming = null">Cancel</button>
          </form>
          <h1 v-else class="truncate text-xl font-semibold">{{ dash.name }}</h1>
          <p class="text-xs text-slate-500">
            {{ dash.visibility === 'shared' ? 'Shared with everyone' : 'Private' }} · {{ dash.mine ? 'yours' : `by ${dash.owner.name}` }}
          </p>
        </div>
        <div v-if="dash.canEdit" class="flex flex-wrap gap-2">
          <button type="button" class="btn" @click="openAdd">Add report</button>
          <button v-if="renaming === null" type="button" class="btn btn-ghost" @click="renaming = dash.name">Rename</button>
          <label class="sr-only" for="dash-vis">Who can see it</label>
          <select
            id="dash-vis"
            class="input w-auto"
            :value="dash.visibility"
            :disabled="saving"
            @change="save({ visibility: $event.target.value })"
          >
            <option value="private">Private</option>
            <option value="shared">Shared</option>
          </select>
          <button type="button" class="btn btn-danger" @click="removeDashboard">Delete</button>
        </div>
      </div>

      <div v-if="!dash.layout.length" class="card px-4 py-10 text-center">
        <p class="font-semibold">This dashboard is empty</p>
        <p v-if="dash.canEdit" class="mt-1 text-sm text-slate-500">Add a saved report, or build a new one.</p>
        <div v-if="dash.canEdit" class="mt-3 flex flex-wrap justify-center gap-2">
          <button type="button" class="btn btn-primary" @click="openAdd">Add report</button>
          <RouterLink :to="`/reports/new?dashboard=${dash.id}`" class="btn">Build a new report</RouterLink>
        </div>
      </div>
      <div v-else class="grid gap-4 lg:grid-cols-2">
        <ReportCard
          v-for="(x, i) in dash.layout"
          :key="`${x.reportId}-${i}`"
          :report="x.report"
          :width="x.width"
          :editable="dash.canEdit"
          :first="i === 0"
          :last="i === dash.layout.length - 1"
          @move="move(i, $event)"
          @width="setWidth(i, $event)"
          @remove="remove(i)"
        />
      </div>
      <p v-if="dash.visibility === 'shared'" class="text-xs text-slate-500">
        Each person sees the numbers for issues they can see. Private reports on a shared dashboard show as unavailable to others.
      </p>
    </template>

    <Modal v-if="adding" title="Add a report" @close="adding = false">
      <p v-if="!allReports.length" class="text-sm text-slate-500">No saved reports yet.</p>
      <ul v-else class="max-h-80 divide-y divide-slate-100 overflow-y-auto">
        <li v-for="r in allReports" :key="r.id" class="flex items-center gap-2 py-2">
          <div class="min-w-0 flex-1">
            <div class="truncate font-medium">{{ r.name }}</div>
            <div class="truncate text-xs text-slate-500">
              {{ kindOf(r.kind).label }} · {{ r.mine ? 'yours' : `by ${r.owner.name}` }}{{ r.visibility === 'shared' ? ' · shared' : '' }}
            </div>
          </div>
          <button type="button" class="btn btn-sm" @click="add(r)">{{ onDash.has(r.id) ? 'Add again' : 'Add' }}</button>
        </li>
      </ul>
      <template #footer>
        <RouterLink :to="`/reports/new?dashboard=${dash.id}`" class="btn">Build a new report</RouterLink>
        <button type="button" class="btn" @click="adding = false">Close</button>
      </template>
    </Modal>
  </div>
</template>
