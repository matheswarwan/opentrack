<script setup>
// Project > Status: weekly status reports. The list (/projects/:key/status) and one report (/projects/:key/status/:id)
// are components/status/; this page loads the list once and shows one or the other.
import { ref, inject, computed } from 'vue';
import { useRoute } from 'vue-router';
import { get, toast } from '../../api.js';
import StatusList from '../../components/status/StatusList.vue';
import StatusReport from '../../components/status/StatusReport.vue';

const project = inject('project');
const route = useRoute();
const reports = ref(null);
const canAdmin = ref(false);
const aiAvailable = ref(false);
const base = () => `/api/projects/${project.value.key}/status-reports`;
const id = computed(() => route.params.id || null);

async function loadList() {
  try {
    const r = await get(base());
    reports.value = r.reports;
    canAdmin.value = r.canAdmin;
    aiAvailable.value = r.aiAvailable;
  } catch (e) {
    toast(e.message, 'error');
    reports.value = [];
  }
}
loadList();
</script>

<template>
  <div class="max-w-5xl space-y-3">
    <StatusList v-if="!id" :reports="reports" :can-admin="canAdmin" :load-list="loadList" />
    <StatusReport v-else :id="id" v-model:can-admin="canAdmin" :ai-available="aiAvailable" :load-list="loadList" />
  </div>
</template>
