<script setup>
import { onMounted, onBeforeUnmount } from 'vue';
import IssueDetail from './IssueDetail.vue';
defineProps({ issueKey: String });
const emit = defineEmits(['close']);
const onKey = (e) => {
  if (e.key === 'Escape' && !document.querySelector('[role=dialog]')) emit('close');
};
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>
<template>
  <div
    class="fixed bottom-0 right-0 top-12 z-40 w-full max-w-5xl lg:top-0 overflow-y-auto overflow-x-hidden border-l border-slate-200 bg-white p-5 shadow-2xl"
  >
    <IssueDetail :issue-key="issueKey" panel @close="emit('close')" @deleted="emit('close')" />
  </div>
</template>
