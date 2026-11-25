<script setup>
// Asked when a timer is stopped: an optional note, the billable flag, and the hours when the timer ran so long
// that logging it blindly would probably be wrong (over 12 hours).
import { ref, computed } from 'vue';
import { timerState, elapsedMs, minutesOf, minutesText, stopTimer } from '../timer.js';
import Modal from './Modal.vue';

const t = timerState.timer;
const minutes = minutesOf(elapsedMs()); // as it was when the dialog opened; the server uses the time at Stop
const long = computed(() => minutes / 60 > timerState.confirmAfterHours);
const form = ref({ note: '', billable: true, hours: long.value ? Math.min(24, Math.round((minutes / 60) * 100) / 100) : '' });
const close = () => {
  timerState.stopping = false;
};

async function save() {
  const opts = { note: form.value.note, billable: form.value.billable !== false };
  if (long.value) opts.hours = Number(form.value.hours);
  if (await stopTimer(opts)) close();
}
</script>
<template>
  <Modal :title="`Stop the timer on ${t.issueKey}`" @close="close">
    <form id="timer-stop" class="space-y-3" @submit.prevent="save">
      <p class="text-sm text-slate-600">{{ t.title }}</p>
      <div v-if="long" class="space-y-2">
        <p class="rounded-md bg-amber-100 px-3 py-2 text-sm text-amber-950" role="alert">
          This timer has run for {{ minutesText(minutes) }}. Check the hours before logging them.
        </p>
        <div>
          <label class="label" for="timer-hours">Hours to log</label
          ><input
            id="timer-hours"
            v-model="form.hours"
            type="number"
            min="0.01"
            max="24"
            step="0.01"
            class="input w-32"
            required
            autofocus
          />
        </div>
      </div>
      <p v-else class="text-sm">
        Time to log: <strong>{{ minutesText(minutes) }}</strong> (rounded up to the minute)
      </p>
      <div>
        <label class="label" for="timer-note">What did you do? (optional)</label
        ><input id="timer-note" v-model="form.note" class="input" maxlength="2000" :autofocus="!long" />
      </div>
      <label class="flex items-center gap-2 text-sm"
        ><input v-model="form.billable" type="checkbox" /> Billable (counts against the project budget)</label
      >
    </form>
    <template #footer
      ><button class="btn" @click="close">Keep running</button
      ><button class="btn btn-primary" form="timer-stop" :disabled="timerState.busy">Stop and log</button></template
    >
  </Modal>
</template>
