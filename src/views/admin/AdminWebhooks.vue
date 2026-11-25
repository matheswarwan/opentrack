<script setup>
// Admin > Webhooks: workspace-wide webhooks (every project). Project webhooks are under Project settings.
import WebhooksPanel from '../../components/WebhooksPanel.vue';
</script>
<template>
  <div class="max-w-3xl space-y-4">
    <WebhooksPanel
      base="/api/admin/webhooks"
      intro="Workspace-wide webhooks get events from every project, including members-only ones. Project admins can add webhooks for one project under Project settings."
    />
  </div>
</template>
