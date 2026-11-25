<script setup>
// Progress bar of a release: done, in progress and to do, by issue count (or story points with by="points").
import { computed } from 'vue';
import { plural } from '../plural.js';

const props = defineProps({ progress: { type: Object, required: true }, by: { type: String, default: 'issues' } });
const parts = computed(() => {
  const p = props.progress;
  if (props.by === 'points') {
    const total = p.points || 0;
    return { total, done: p.pointsDone || 0, doing: 0, unit: 'points' };
  }
  return { total: p.total || 0, done: p.done || 0, doing: p.inProgress || 0, unit: 'issues' };
});
const pct = (n) => (parts.value.total ? (n / parts.value.total) * 100 : 0);
const text = computed(() => {
  const { total, done, unit } = parts.value;
  if (!total) return unit === 'points' ? 'No story points' : 'No issues';
  return `${done} of ${total} ${unit === 'points' ? 'points' : plural(total, 'issue')} done (${Math.round(pct(done))}%)`;
});
</script>

<template>
  <div class="min-w-0">
    <div class="flex h-2 overflow-hidden rounded-full bg-slate-200" role="img" :aria-label="text">
      <div class="bg-link" :style="{ width: pct(parts.done) + '%' }"></div>
      <div class="bg-info" :style="{ width: pct(parts.doing) + '%' }"></div>
    </div>
    <p class="mt-1 text-xs text-slate-500">{{ text }}</p>
  </div>
</template>
