<script setup>
// "Blocked" chip for an issue another open issue blocks (issue.blocked from the API). compact: icon only.
import { computed } from 'vue';
import Icon from './Icon.vue';
import { blockedText } from '../meta.js';
const props = defineProps({ issue: Object, compact: Boolean });
const text = computed(() => blockedText(props.issue));
</script>
<template>
  <span v-if="issue?.blocked" class="chip shrink-0 gap-1 bg-red-100 text-red-800" :title="text" :aria-label="text"
    ><Icon name="block" :size="12" /><span v-if="!compact">Blocked</span></span
  >
</template>
