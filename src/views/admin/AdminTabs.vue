<script setup>
import { useRoute } from 'vue-router';
const route = useRoute();
const tabs = [
  { to: '/admin/users', label: 'Users' },
  { to: '/admin/feedback', label: 'Feedback' },
  { to: '/admin/settings', label: 'Settings' },
  { to: '/admin/templates', label: 'Templates' },
  { to: '/admin/slack', label: 'Slack' },
  { to: '/admin/webhooks', label: 'Webhooks' },
  { to: '/admin/backups', label: 'Backups' },
  { to: '/admin/jira-import', label: 'Import from Jira' },
  { to: '/admin/audit', label: 'Audit log' },
  { to: '/admin/mcp', label: 'AI audit (MCP)' },
];
</script>
<template>
  <div class="mb-4 flex items-center gap-1 overflow-x-auto whitespace-nowrap border-b border-slate-200">
    <h1 class="mr-4 text-xl font-semibold">Admin</h1>
    <RouterLink
      v-for="t in tabs"
      :key="t.to"
      :to="t.to"
      class="px-3 py-2 text-sm"
      :class="route.path === t.to ? 'border-b-2 border-blue-700 font-semibold text-blue-800' : 'text-slate-600'"
      >{{ t.label }}</RouterLink
    >
  </div>
</template>
