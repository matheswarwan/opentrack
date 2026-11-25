<script setup>
// Profile card: which notifications also come by email. Slack messages are in the card below it.
import { ref, onMounted } from 'vue';
import { get, put, toast } from '../api.js';
import { attempt } from '../composables/useAction.js';

const state = ref(null);
const TYPES = [
  ['assigned', 'Someone assigns an issue to me'],
  ['mentioned', 'Someone mentions me or replies to my comment'],
  ['comment', 'New comments on issues I watch'],
  ['status', 'Status changes on issues I watch'],
];
onMounted(async () => {
  try {
    state.value = await get('/api/me/email');
  } catch {
    state.value = null;
  }
});
async function set(type, on) {
  await attempt(async () => {
    state.value = await put('/api/me/email', { [type]: on });
    toast('Email settings saved');
  });
}
</script>
<template>
  <section v-if="state" class="card space-y-2 p-4">
    <h2 class="text-sm font-semibold">Notifications</h2>
    <p class="text-sm text-slate-600">You always see notifications in the app. Choose which ones also come by email.</p>
    <p v-if="!state.configured" class="text-xs text-slate-500">
      Email is not set up on this server yet, so no emails are sent. Your choices are kept for when it is.
    </p>
    <label v-for="t in TYPES" :key="t[0]" class="flex items-center gap-2 text-sm">
      <input type="checkbox" :checked="state.prefs[t[0]]" @change="set(t[0], $event.target.checked)" />
      Email me when: {{ t[1] }}
    </label>
  </section>
</template>
