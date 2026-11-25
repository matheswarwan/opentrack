<script setup>
// RAID entries linked to this issue (GET /api/issues/:key/raid). Hidden when there are none; never shown to guests.
import { ref, watch } from 'vue';
import { get } from '../api.js';
import { typeOf, STATUS_LABELS, statusCls, band } from '../raid.js';

const props = defineProps({ issueKey: { type: String, required: true } });
const data = ref(null);
async function load() {
  try {
    data.value = await get(`/api/issues/${props.issueKey}/raid`);
  } catch {
    data.value = null;
  }
}
watch(() => props.issueKey, load, { immediate: true });
defineExpose({ load });
</script>
<template>
  <section v-if="data && data.entries.length" class="mb-5">
    <h2 class="mb-1 text-sm font-semibold text-slate-700">RAID</h2>
    <div v-for="e in data.entries" :key="e.id" class="flex items-center gap-2 py-1 text-sm">
      <span class="chip text-xs" :class="typeOf(e.type).cls">{{ typeOf(e.type).label }}</span>
      <RouterLink :to="`/projects/${data.project}/raid?entry=${e.id}`" class="link shrink-0">{{ e.ref }}</RouterLink>
      <span class="truncate">{{ e.title }}</span>
      <span v-if="band(e.score)" class="chip border text-xs" :class="band(e.score).cls">{{ band(e.score).label }} {{ e.score }}</span>
      <span class="chip ml-auto text-xs" :class="statusCls(e.status)">{{ STATUS_LABELS[e.status] || e.status }}</span>
    </div>
  </section>
</template>
