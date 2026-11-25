<script setup>
import { categoryCls } from '../meta.js';
defineProps({ status: Object });
</script>
<template>
  <span v-if="status" class="chip whitespace-nowrap uppercase tracking-wide" :class="categoryCls(status.category)">{{ status.name }}</span>
</template>
