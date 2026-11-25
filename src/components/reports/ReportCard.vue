<script setup>
// One saved report on a dashboard: loads its data as the viewer, with refresh and "open as issues".
import { ref, computed, watch } from 'vue';
import { post } from '../../api.js';
import { ui } from '../../ui.js';
import { kindOf, issuesLink } from '../../reports.js';
import ReportResult from './ReportResult.vue';

const props = defineProps({
  report: { type: Object, default: null },
  width: { type: String, default: 'half' },
  editable: Boolean, // dashboard owner: show layout controls
  first: Boolean,
  last: Boolean,
});
const emit = defineEmits(['remove', 'move', 'width']);
const result = ref(null);
const error = ref('');
const loading = ref(false);

async function load() {
  if (!props.report) return;
  loading.value = true;
  try {
    result.value = await post('/api/report-data', { reportId: props.report.id });
    error.value = '';
  } catch (e) {
    error.value = e.message;
  }
  loading.value = false;
}
watch(() => [props.report?.id, props.report?.updatedAt, ui.changes], load, { immediate: true });

const issuesHref = computed(() => {
  if (!result.value) return null;
  const extra = result.value.kind === 'workload' && !result.value.includeDone ? { category: 'todo,in_progress' } : {};
  return issuesLink(result.value.query, extra);
});
const updated = computed(() =>
  result.value ? new Date(result.value.generatedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '',
);
</script>
<template>
  <section
    class="card min-w-0 p-4"
    :class="width === 'full' ? 'lg:col-span-2' : ''"
    :aria-label="report ? report.name : 'Unavailable report'"
  >
    <template v-if="report">
      <div class="mb-2 flex flex-wrap items-start gap-2">
        <div class="min-w-0 flex-1">
          <h3 class="truncate font-semibold" :title="report.name">{{ report.name }}</h3>
          <p class="truncate text-xs text-slate-500">
            {{ report.description || kindOf(report.kind).label }}<template v-if="updated"> · updated {{ updated }}</template>
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-1">
          <button type="button" class="btn btn-ghost btn-sm" :disabled="loading" @click="load">
            {{ loading ? 'Loading...' : 'Refresh' }}
          </button>
          <RouterLink v-if="issuesHref" :to="issuesHref" class="btn btn-ghost btn-sm">Open as issues</RouterLink>
          <RouterLink v-if="report.canEdit" :to="`/reports/${report.id}/edit`" class="btn btn-ghost btn-sm">Edit</RouterLink>
        </div>
      </div>
      <p v-if="error" class="py-6 text-center text-sm text-red-700">{{ error }}</p>
      <p v-else-if="!result" class="py-10 text-center text-sm text-slate-500">Loading...</p>
      <ReportResult v-else :result="result" :title="report.name" />
    </template>
    <p v-else class="py-6 text-center text-sm text-slate-500">This report is private or was deleted.</p>

    <div v-if="editable" class="mt-3 flex flex-wrap gap-1 border-t border-slate-100 pt-2">
      <button type="button" class="btn btn-ghost btn-sm" :disabled="first" aria-label="Move earlier" @click="emit('move', -1)">
        Move up
      </button>
      <button type="button" class="btn btn-ghost btn-sm" :disabled="last" aria-label="Move later" @click="emit('move', 1)">
        Move down
      </button>
      <button type="button" class="btn btn-ghost btn-sm hidden lg:inline-flex" @click="emit('width', width === 'full' ? 'half' : 'full')">
        {{ width === 'full' ? 'Half width' : 'Full width' }}
      </button>
      <button type="button" class="btn btn-ghost btn-sm text-red-700" @click="emit('remove')">Remove</button>
    </div>
  </section>
</template>
