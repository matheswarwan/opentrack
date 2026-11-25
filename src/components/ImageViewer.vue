<script setup>
// Full-screen viewer for image attachments: arrows or ←/→ to move, Esc to close.
import { onMounted, onBeforeUnmount, computed } from 'vue';
import { fmtSize } from '../attachments.js';
const props = defineProps({ images: Array, index: Number });
const emit = defineEmits(['close', 'update:index']);
const cur = computed(() => props.images[props.index]);
const go = (d) => emit('update:index', (props.index + d + props.images.length) % props.images.length);
function onKey(e) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    emit('close');
  } else if (e.key === 'ArrowRight') go(1);
  else if (e.key === 'ArrowLeft') go(-1);
}
onMounted(() => window.addEventListener('keydown', onKey, true));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true));
</script>
<template>
  <div
    class="fixed inset-0 z-[90] flex flex-col bg-black/90 text-white"
    role="dialog"
    aria-modal="true"
    :aria-label="cur?.filename"
    @click.self="emit('close')"
  >
    <div class="flex items-center gap-3 px-4 py-3 text-sm">
      <span class="truncate font-medium">{{ cur.filename }}</span>
      <span class="text-white/60"
        >{{ fmtSize(cur.size) }}<template v-if="images.length > 1"> · {{ index + 1 }} of {{ images.length }}</template></span
      >
      <a :href="cur.url" :download="cur.filename" class="btn btn-sm ml-auto border-white bg-transparent text-white hover:bg-white/10"
        >Download</a
      >
      <a :href="cur.url" target="_blank" rel="noopener" class="btn btn-sm border-white bg-transparent text-white hover:bg-white/10"
        >Open in new tab</a
      >
      <button class="rounded-full px-2 text-2xl leading-none hover:bg-white/10" aria-label="Close" @click="emit('close')">×</button>
    </div>
    <div class="relative flex min-h-0 flex-1 items-center justify-center px-12 pb-6" @click.self="emit('close')">
      <img :src="cur.url" :alt="cur.filename" class="max-h-full max-w-full rounded object-contain" />
      <template v-if="images.length > 1">
        <button
          class="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-white/10 px-3 py-2 text-2xl hover:bg-white/20"
          aria-label="Previous image"
          @click="go(-1)"
        >
          ‹
        </button>
        <button
          class="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-white/10 px-3 py-2 text-2xl hover:bg-white/20"
          aria-label="Next image"
          @click="go(1)"
        >
          ›
        </button>
      </template>
    </div>
  </div>
</template>
