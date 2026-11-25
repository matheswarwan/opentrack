<script setup>
// Profile card: due-date reminders and the weekly digest by Slack and email (the in-app notification always comes).
import { ref, onMounted } from 'vue';
import { get, put, toast } from '../api.js';
import { attempt } from '../composables/useAction.js';

const prefs = ref(null);
const ROWS = [
  ['due', 'Due-date reminders', 'Once a day, one message listing your open issues that are overdue or due today or tomorrow.'],
  ['digest', 'Weekly digest', 'Your open issues, what is due, changes on issues you watch, and your mentions.'],
];
onMounted(async () => {
  try {
    prefs.value = (await get('/api/me/reminders')).prefs;
  } catch {
    prefs.value = null;
  }
});
async function set(key, on) {
  await attempt(async () => {
    prefs.value = (await put('/api/me/reminders', { [key]: on })).prefs;
    toast('Reminder settings saved');
  });
}
</script>
<template>
  <section v-if="prefs" class="card space-y-3 p-4">
    <h2 class="text-sm font-semibold">Reminders and weekly digest</h2>
    <p class="text-sm text-slate-600">
      These always show in the app (the bell). Choose whether they also come by Slack and email, when those are set up.
      <RouterLink to="/digest" class="link">See your digest now</RouterLink>.
    </p>
    <div v-for="r in ROWS" :key="r[0]" class="space-y-1">
      <div class="text-sm font-medium">{{ r[1] }}</div>
      <p class="text-xs text-slate-500">{{ r[2] }}</p>
      <div class="flex flex-wrap gap-x-4 gap-y-1">
        <label class="flex items-center gap-2 text-sm"
          ><input type="checkbox" :checked="prefs[`${r[0]}Slack`]" @change="set(`${r[0]}Slack`, $event.target.checked)" /> Slack</label
        >
        <label class="flex items-center gap-2 text-sm"
          ><input type="checkbox" :checked="prefs[`${r[0]}Email`]" @change="set(`${r[0]}Email`, $event.target.checked)" /> Email</label
        >
      </div>
    </div>
  </section>
</template>
