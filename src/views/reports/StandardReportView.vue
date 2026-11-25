<script setup>
// One standard report: pick a project (or all), see it, save a copy or add it to a dashboard.
import { ref, computed, watch, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { get, post, patch, toast } from '../../api.js';
import { standardReport, standardDefinition } from '../../standardReports.js';
import { issuesLink } from '../../reports.js';
import { projectList } from '../../projects.js';
import ReportResult from '../../components/reports/ReportResult.vue';
import Skeleton from '../../components/Skeleton.vue';
import { attempt } from '../../composables/useAction.js';

const route = useRoute();
const router = useRouter();
const report = computed(() => standardReport(String(route.params.id)));
const projectKey = computed(() => String(route.query.project || ''));
const projects = ref([]);
const dashboards = ref([]);
const result = ref(null);
const error = ref('');
const loading = ref(true);
const busy = ref(false);
const dashboardId = ref('');

onMounted(async () => {
  [projects.value, dashboards.value] = await Promise.all([
    projectList().catch(() => []),
    get('/api/dashboards')
      .then((r) => r.dashboards.filter((d) => d.canEdit))
      .catch(() => []),
  ]);
});
async function run() {
  if (!report.value) return;
  loading.value = true;
  try {
    result.value = await post('/api/report-data', standardDefinition(report.value, projectKey.value));
    error.value = '';
  } catch (e) {
    error.value = e.message;
    result.value = null;
  } finally {
    loading.value = false;
  }
}
watch([report, projectKey], run, { immediate: true });
const setProject = (k) => router.replace({ query: k ? { project: k } : {} });
const scopeName = computed(() => projects.value.find((p) => p.key === projectKey.value)?.name);
const savedName = computed(() => `${report.value.name}${scopeName.value ? ` (${scopeName.value})` : ''}`);

async function save(toDashboard) {
  busy.value = true;
  await attempt(async () => {
    const r = (
      await post('/api/saved-reports', {
        ...standardDefinition(report.value, projectKey.value),
        name: savedName.value,
        description: report.value.description,
        visibility: 'private',
      })
    ).report;
    if (toDashboard) {
      const d = (await get(`/api/dashboards/${dashboardId.value}`)).dashboard;
      const width = r.kind === 'list' || r.kind === 'createdVsResolved' || r.kind === 'twoD' ? 'full' : 'half';
      await patch(`/api/dashboards/${d.id}`, {
        layout: [...d.layout.map((x) => ({ reportId: x.reportId, width: x.width })), { reportId: r.id, width }],
      });
      toast(`Added to ${d.name}`);
      router.push(`/reports/dashboards/${d.id}`);
    } else {
      toast('Saved under Reports > Reports. You can change it there.');
      router.push(`/reports/${r.id}`);
    }
  });
  busy.value = false;
}
</script>

<template>
  <div v-if="!report" class="py-16 text-center text-slate-600">
    Report not found. <RouterLink to="/reports?tab=standard" class="link">See all standard reports</RouterLink>
  </div>
  <div v-else class="mx-auto max-w-6xl space-y-4 pb-10">
    <div class="text-xs text-slate-500">
      <RouterLink to="/reports?tab=standard" class="hover:underline">Reports</RouterLink> / {{ report.group }}
    </div>
    <div class="flex flex-wrap items-end gap-3">
      <div class="min-w-0 flex-1">
        <h1 class="text-xl font-semibold">{{ report.name }}</h1>
        <p class="text-sm text-slate-500">{{ report.description }}</p>
      </div>
      <label class="w-56"
        ><span class="label">Project</span>
        <select :value="projectKey" class="input" @change="setProject($event.target.value)">
          <option value="">All projects</option>
          <option v-for="p in projects" :key="p.key" :value="p.key">{{ p.name }}</option>
        </select>
      </label>
    </div>
    <div class="card p-4">
      <Skeleton v-if="loading && !result" :rows="5" />
      <p v-else-if="error" class="py-6 text-center text-sm text-red-700">{{ error }}</p>
      <ReportResult v-else-if="result" :result="result" :title="report.name" />
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <RouterLink v-if="result" :to="issuesLink(result.query)" class="btn">Open as issues</RouterLink>
      <button class="btn" :disabled="busy" @click="save(false)">Save a copy to edit</button>
      <template v-if="dashboards.length">
        <select v-model="dashboardId" class="input w-56" aria-label="Dashboard">
          <option value="">Add to a dashboard…</option>
          <option v-for="d in dashboards" :key="d.id" :value="d.id">{{ d.name }}</option>
        </select>
        <button class="btn btn-primary" :disabled="busy || !dashboardId" @click="save(true)">Add</button>
      </template>
    </div>
  </div>
</template>
