<script setup>
// Reports page: dashboards and saved custom reports (like Jira dashboards and filter gadgets).
import { ref, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { get, post, del, toast } from '../../api.js';
import { kindOf } from '../../reports.js';
import { STANDARD_GROUPS } from '../../standardReports.js';
import { ago } from '../../meta.js';
import Modal from '../../components/Modal.vue';
import Icon from '../../components/Icon.vue';
import { attempt } from '../../composables/useAction.js';
import { plural } from '../../plural.js';

const route = useRoute();
const router = useRouter();
const tab = computed(() => (['reports', 'dashboards'].includes(route.query.tab) ? route.query.tab : 'standard'));
const KIND_ICON = { breakdown: 'chart', twoD: 'board', createdVsResolved: 'chart', averageAge: 'clock', workload: 'user', list: 'list' };
const dashboards = ref(null);
const reports = ref(null);
const error = ref('');
const creating = ref(null); // { name } for a new dashboard
const busy = ref(false);

async function load() {
  try {
    [dashboards.value, reports.value] = await Promise.all([
      get('/api/dashboards').then((r) => r.dashboards),
      get('/api/saved-reports').then((r) => r.reports),
    ]);
    error.value = '';
  } catch (e) {
    error.value = e.message;
  }
}
watch(
  () => route.fullPath,
  () => {
    if (route.name === 'reports') load();
  },
  { immediate: true },
);

const setTab = (t) => router.replace({ query: t === 'standard' ? {} : { tab: t } });

async function starter() {
  busy.value = true;
  await attempt(async () => {
    const r = await post('/api/dashboards/starter');
    toast('Dashboard created');
    router.push(`/reports/dashboards/${r.dashboard.id}`);
  });
  busy.value = false;
}
async function createDashboard() {
  busy.value = true;
  await attempt(async () => {
    const r = await post('/api/dashboards', { name: creating.value.name, visibility: 'private', layout: [] });
    creating.value = null;
    router.push(`/reports/dashboards/${r.dashboard.id}`);
  });
  busy.value = false;
}
async function removeReport(r) {
  if (!confirm(`Delete the report "${r.name}"? Dashboards that show it will show an empty card.`)) return;
  await attempt(async () => {
    await del(`/api/saved-reports/${r.id}`);
    reports.value = reports.value.filter((x) => x.id !== r.id);
    toast('Report deleted');
  });
}
</script>
<template>
  <div class="mx-auto max-w-6xl space-y-4 pb-10">
    <div class="flex flex-wrap items-end gap-3">
      <div class="min-w-0 flex-1">
        <h1 class="text-xl font-semibold">Reports</h1>
        <p class="text-sm text-slate-500">Charts and tables built from issue searches. Everyone sees only issues they have access to.</p>
      </div>
      <RouterLink to="/reports/new" class="btn btn-primary">New report</RouterLink>
    </div>

    <div class="flex gap-1 border-b border-slate-200" role="tablist">
      <button
        v-for="t in [
          { id: 'standard', label: 'Standard reports' },
          { id: 'dashboards', label: 'Dashboards' },
          { id: 'reports', label: 'My reports' },
        ]"
        :key="t.id"
        type="button"
        role="tab"
        :aria-selected="tab === t.id"
        class="-mb-px border-b-2 px-3 py-2 text-sm font-semibold"
        :class="tab === t.id ? 'border-accent text-black' : 'border-transparent text-slate-500 hover:text-black'"
        @click="setTab(t.id)"
      >
        {{ t.label }}
      </button>
    </div>

    <!-- standard reports -->
    <template v-if="tab === 'standard'">
      <p class="text-sm text-slate-600">
        Ready-made reports. Open one, pick a project or all projects, then save a copy to change it or add it to a dashboard. Sprint
        burndown, velocity and cycle time are on each project's <strong>Reports</strong> tab.
      </p>
      <section v-for="g in STANDARD_GROUPS" :key="g.id" class="space-y-2">
        <h2 class="text-xs font-bold uppercase tracking-wider text-slate-500">{{ g.title }}</h2>
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <RouterLink
            v-for="r in g.reports"
            :key="r.id"
            :to="`/reports/standard/${r.id}`"
            class="card group flex gap-3 p-4 hover:border-slate-400"
          >
            <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface text-accent" aria-hidden="true"
              ><Icon :name="KIND_ICON[r.kind]" :size="18"
            /></span>
            <span class="min-w-0">
              <span class="block font-semibold group-hover:underline">{{ r.name }}</span>
              <span class="block text-sm text-slate-500">{{ r.description }}</span>
            </span>
          </RouterLink>
        </div>
      </section>
    </template>
    <p v-else-if="error" class="card px-4 py-6 text-center text-sm text-red-700">{{ error }}</p>
    <p v-else-if="!dashboards" class="card px-4 py-10 text-center text-sm text-slate-500">Loading...</p>

    <!-- dashboards -->
    <template v-else-if="tab === 'dashboards'">
      <div class="flex flex-wrap gap-2">
        <button type="button" class="btn" @click="creating = { name: '' }">New dashboard</button>
        <button type="button" class="btn" :disabled="busy" @click="starter">Create my dashboard</button>
      </div>
      <div v-if="!dashboards.length" class="card px-4 py-10 text-center">
        <p class="font-semibold">No dashboards yet</p>
        <p class="mx-auto mt-1 max-w-md text-sm text-slate-500">
          "Create my dashboard" adds four reports: your open work by status, workload by assignee, created vs resolved for 30 days, and
          issues due soon.
        </p>
        <button type="button" class="btn btn-primary mt-3" :disabled="busy" @click="starter">Create my dashboard</button>
      </div>
      <ul v-else class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <li v-for="d in dashboards" :key="d.id">
          <RouterLink :to="`/reports/dashboards/${d.id}`" class="card block h-full p-4 hover:border-black">
            <div class="flex items-start gap-2">
              <span class="min-w-0 flex-1 truncate font-semibold">{{ d.name }}</span>
              <span v-if="d.visibility === 'shared'" class="chip bg-surface text-black">Shared</span>
            </div>
            <p class="mt-1 text-xs text-slate-500">
              {{ d.layout.length }} {{ plural(d.layout.length, 'report') }} · {{ d.mine ? 'yours' : `by ${d.owner.name}` }} · updated
              {{ ago(d.updatedAt) }}
            </p>
          </RouterLink>
        </li>
      </ul>
    </template>

    <!-- reports -->
    <template v-else>
      <div v-if="!reports.length" class="card px-4 py-10 text-center">
        <p class="font-semibold">No saved reports yet</p>
        <p class="mt-1 text-sm text-slate-500">Build one from a saved filter, a project or any issue search.</p>
        <RouterLink to="/reports/new" class="btn btn-primary mt-3">New report</RouterLink>
      </div>
      <ul v-else class="card divide-y divide-slate-100">
        <li v-for="r in reports" :key="r.id" class="flex flex-wrap items-center gap-2 px-4 py-3">
          <div class="min-w-0 flex-1">
            <RouterLink :to="`/reports/${r.id}`" class="font-semibold hover:underline">{{ r.name }}</RouterLink>
            <span v-if="r.visibility === 'shared'" class="chip ml-2 bg-surface text-black">Shared</span>
            <p class="truncate text-xs text-slate-500">
              {{ kindOf(r.kind).label }} · {{ r.mine ? 'yours' : `by ${r.owner.name}`
              }}<template v-if="r.description"> · {{ r.description }}</template>
            </p>
          </div>
          <RouterLink v-if="r.canEdit" :to="`/reports/${r.id}/edit`" class="btn btn-ghost btn-sm">Edit</RouterLink>
          <button v-if="r.canEdit" type="button" class="btn btn-ghost btn-sm text-red-700" @click="removeReport(r)">Delete</button>
        </li>
      </ul>
    </template>

    <Modal v-if="creating" title="New dashboard" @close="creating = null">
      <form id="new-dash" @submit.prevent="createDashboard">
        <label class="label" for="dash-name">Name</label>
        <input id="dash-name" v-model="creating.name" class="input" maxlength="100" required autofocus />
      </form>
      <template #footer>
        <button type="button" class="btn" @click="creating = null">Cancel</button>
        <button type="submit" form="new-dash" class="btn btn-primary" :disabled="busy || !creating.name.trim()">Create</button>
      </template>
    </Modal>
  </div>
</template>
