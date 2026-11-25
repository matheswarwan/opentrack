<script setup>
import { computed } from 'vue';
import { priorityOf } from '../meta.js';
const props = defineProps({ priority: String, label: Boolean });
const p = computed(() => priorityOf(props.priority));
</script>
<template>
  <span class="inline-flex items-center gap-1 text-sm" :title="p.label + ' priority'"
    ><span class="font-bold" :style="{ color: p.color }">{{ p.arrow }}</span
    ><span v-if="label">{{ p.label }}</span></span
  >
</template>
