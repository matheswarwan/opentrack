<script setup>
// Project > Status, the list: every status report of the project, and New status report for project admins.
import { ref, reactive, inject } from 'vue';
import { useRouter } from 'vue-router';
import { post } from '../../api.js';
import { RAG, periodText, ragLabel } from '../../statusReport.js';
import Skeleton from '../Skeleton.vue';
import { attempt } from '../../composables/useAction.js';

const props = defineProps({
  reports: { type: Array, default: null }, // null while loading
  canAdmin: Boolean,
  loadList: { type: Function, required: true },
});
const project = inject('project');
const router = useRouter();
const busy = ref(false);
const creating = ref(false);
const period = reactive({ start: '', end: '' });
const base = () => `/api/projects/${project.value.key}/status-reports`;

async function create() {
  busy.value = true;
  await attempt(async () => {
    const r = await post(base(), { periodStart: period.start || undefined, periodEnd: period.end || undefined });
    creating.value = false;
    await props.loadList();
    router.push(`/projects/${project.value.key}/status/${r.report.id}`);
  });
  busy.value = false;
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2">
    <p class="text-sm text-slate-600">
      Weekly status reports for the client, drafted from this project's issues, sprints, releases and work logs.
    </p>
    <button v-if="canAdmin" class="btn btn-sm btn-primary ml-auto" @click="creating = !creating">New status report</button>
  </div>
  <form v-if="creating" class="card grid gap-3 p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" @submit.prevent="create">
    <div>
      <label class="label" for="sr-start">Period start</label><input id="sr-start" v-model="period.start" type="date" class="input" />
    </div>
    <div>
      <label class="label" for="sr-end">Period end</label
      ><input id="sr-end" v-model="period.end" type="date" class="input" :min="period.start || undefined" />
    </div>
    <div class="flex gap-2">
      <button class="btn btn-primary" :disabled="busy">Create draft</button
      ><button type="button" class="btn" @click="creating = false">Cancel</button>
    </div>
    <p class="text-xs text-slate-500 sm:col-span-3">Leave the dates empty for the last 7 days.</p>
  </form>
  <Skeleton v-if="!reports" :rows="4" />
  <div v-else-if="!reports.length" class="card p-6 text-center text-sm text-slate-500">
    No status reports yet.<template v-if="canAdmin"> Use New status report to draft one from this week's work.</template>
  </div>
  <div v-else class="card divide-y divide-slate-100">
    <RouterLink
      v-for="r in reports"
      :key="r.id"
      :to="`/projects/${project.key}/status/${r.id}`"
      class="flex flex-wrap items-center gap-2 px-3 py-3 hover:bg-slate-50"
    >
      <span class="font-semibold">{{ periodText(r) }}</span>
      <span class="chip border" :class="RAG[r.rag.overall]?.cls">Overall: {{ ragLabel(r.rag.overall) }}</span>
      <span v-if="r.status === 'draft'" class="chip bg-slate-100 text-slate-700">Draft</span>
      <span v-else class="chip bg-slate-100 text-slate-700">Published</span>
      <span v-if="r.sharedWithGuests" class="chip bg-slate-100 text-slate-700">Shared with guests</span>
      <span class="ml-auto text-xs text-slate-500">{{ r.author?.name }}</span>
    </RouterLink>
  </div>
</template>
