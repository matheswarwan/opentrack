<script setup>
import { onMounted, onBeforeUnmount } from 'vue';
defineProps({ title: String, wide: Boolean });
const emit = defineEmits(['close']);
const onKey = (e) => {
  if (e.key === 'Escape') emit('close');
};
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>
<template>
  <div
    data-no-capture
    class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 pt-[8vh]"
    @mousedown.self="emit('close')"
  >
    <div
      class="w-full rounded-[15px] bg-white shadow-xl"
      :class="wide ? 'max-w-3xl' : 'max-w-lg'"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
    >
      <div class="flex items-center justify-between border-b border-slate-200 px-5 py-3">
        <h2 class="text-base font-semibold">{{ title }}</h2>
        <button class="btn btn-ghost btn-sm" aria-label="Close" @click="emit('close')">✕</button>
      </div>
      <div class="px-5 py-4"><slot /></div>
      <div v-if="$slots.footer" class="flex justify-end gap-2 border-t border-slate-200 px-5 py-3"><slot name="footer" /></div>
    </div>
  </div>
</template>
