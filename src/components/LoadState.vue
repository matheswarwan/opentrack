<script setup>
// What a view shows instead of its content while it loads (skeleton) or when the load
// failed (the error and a way to retry). Pairs with composables/useLoad.js. The default slot
// is the content; a "loading" slot replaces the skeleton where a view has its own.
import Skeleton from './Skeleton.vue';

defineProps({ loading: Boolean, error: { type: String, default: '' }, rows: { type: Number, default: 4 }, card: Boolean });
defineEmits(['retry']);
</script>
<template>
  <div v-if="error" class="card p-6 text-center" role="alert">
    <p class="text-sm text-red-700">Could not load: {{ error }}</p>
    <button type="button" class="btn btn-sm mt-3" @click="$emit('retry')">Try again</button>
  </div>
  <slot v-else-if="loading" name="loading"><Skeleton :rows="rows" :card="card" /></slot>
  <slot v-else />
</template>
