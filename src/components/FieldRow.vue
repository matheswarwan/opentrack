<script setup>
// One row of the issue's field card: the field name on the left, its control (the slot) on the right.
// top: for a tall control (a list), the name lines up with its first line.
defineProps({ label: { type: String, required: true }, top: Boolean });
</script>
<template>
  <div class="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2 px-3 py-2" :class="top ? 'items-start' : 'items-center'">
    <span class="text-slate-500" :class="top ? 'pt-1' : ''">{{ label }}</span>
    <slot />
  </div>
</template>
