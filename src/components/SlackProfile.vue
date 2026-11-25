<script setup>
// Profile card: personal Slack messages for assignments and mentions (shown only when Slack is connected).
import { ref, onMounted } from 'vue';
import { get, put, toast } from '../api.js';
import { attempt } from '../composables/useAction.js';

const status = ref(null);
onMounted(async () => {
  try {
    status.value = await get('/api/slack/status');
  } catch {
    status.value = null;
  }
});
async function setDm(dm) {
  await attempt(async () => {
    await put('/api/me/slack', { dm });
    status.value.dm = dm;
    toast(dm ? 'Slack messages on' : 'Slack messages off');
  });
}
</script>
<template>
  <div v-if="status?.connected" class="card space-y-2 p-4">
    <h2 class="text-sm font-semibold">Slack</h2>
    <label class="flex items-center gap-2 text-sm">
      <input type="checkbox" :checked="status.dm" @change="setDm($event.target.checked)" />
      Slack messages for assignments and mentions
    </label>
    <p class="text-xs text-slate-500">Sent by the app in Slack to the account that uses your email address here.</p>
  </div>
</template>
