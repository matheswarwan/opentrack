<script setup>
// Grey placeholder lines while data loads.
defineProps({ rows: { type: Number, default: 4 }, card: Boolean });
</script>
<template>
  <div class="animate-pulse space-y-2.5" aria-busy="true" aria-label="Loading">
    <div
      v-for="n in rows"
      :key="n"
      class="flex items-center gap-3"
      :class="card ? 'rounded-[15px] border border-slate-200 bg-white p-3' : ''"
    >
      <div class="h-4 w-4 rounded bg-slate-200"></div>
      <div class="h-3 rounded-full bg-slate-200" :style="{ width: `${40 + ((n * 37) % 45)}%` }"></div>
      <div class="ml-auto h-5 w-5 rounded-full bg-slate-200"></div>
    </div>
  </div>
</template>
