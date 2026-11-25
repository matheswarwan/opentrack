<script setup>
import { session } from '../api.js';
defineProps({ title: String });
</script>
<template>
  <div class="flex min-h-screen items-center justify-center bg-slate-100 p-4">
    <div class="w-full max-w-sm">
      <div class="mb-6 flex flex-col items-center gap-3">
        <img src="/logo-mark.svg" alt="" class="h-14 w-14" />
        <div class="text-lg font-semibold">{{ session.appName }}</div>
      </div>
      <div class="card p-6 shadow-sm">
        <h1 class="mb-4 text-lg font-semibold">{{ title }}</h1>
        <slot />
      </div>
    </div>
  </div>
</template>
