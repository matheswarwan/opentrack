<script setup>
// One saved report on its own page.
import { ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { get } from '../../api.js';
import ReportCard from '../../components/reports/ReportCard.vue';

const route = useRoute();
const report = ref(null);
const error = ref('');
watch(
  () => route.params.id,
  async (id) => {
    if (!id) return;
    try {
      report.value = (await get(`/api/saved-reports/${id}`)).report;
      error.value = '';
    } catch (e) {
      error.value = e.message;
    }
  },
  { immediate: true },
);
</script>
<template>
  <div class="mx-auto max-w-6xl space-y-3 pb-10">
    <RouterLink to="/reports?tab=reports" class="text-xs text-slate-500 hover:underline">Reports</RouterLink>
    <p v-if="error" class="card px-4 py-6 text-center text-sm text-red-700">{{ error }}</p>
    <p v-else-if="!report" class="card px-4 py-10 text-center text-sm text-slate-500">Loading...</p>
    <div v-else class="grid gap-4 lg:grid-cols-2">
      <ReportCard :report="report" width="full" />
    </div>
    <p v-if="report && !report.mine" class="text-xs text-slate-500">
      Shared by {{ report.owner.name }}. The numbers cover the issues you can see.
    </p>
  </div>
</template>
