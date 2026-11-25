<script setup>
// Shell of every /admin page: the heading and tabs once, the page under them (router.js).
import AdminTabs from './AdminTabs.vue';
import { session } from '../../api.js';
</script>
<template>
  <AdminTabs />
  <p
    v-if="session.demo"
    class="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
    role="note"
    data-demo-admin
  >
    Read-only demo: you can see every admin page and setting, but changes here are not saved.
  </p>
  <RouterView />
</template>
