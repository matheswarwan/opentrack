<script setup>
// Admin > Settings card: scheduled jobs (due-date reminders, weekly digest, emptying old Trash items, the backup copy). The time zone is part of the
// settings form (saved with Save settings, a v-model:settings that is replaced, never edited in place); hour, day and on/off save at once.
import { ref, onMounted, computed } from 'vue';
import { get, post, patch, toast } from '../api.js';
import { ago } from '../meta.js';
import { attempt } from '../composables/useAction.js';

const settings = defineModel('settings', { type: Object, required: true });
const timeZone = computed({ get: () => settings.value.timeZone, set: (v) => (settings.value = { ...settings.value, timeZone: v }) });
const state = ref(null);
const busy = ref('');
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hh = (h) => `${String(h).padStart(2, '0')}:00`;
const zones = computed(() => {
  let list = [];
  try {
    list = Intl.supportedValuesOf('timeZone');
  } catch {
    list = [];
  }
  return list.includes(timeZone.value) ? list : [timeZone.value, ...list];
});
async function load() {
  await attempt(async () => {
    state.value = await get('/api/admin/jobs');
  });
}
onMounted(load);
async function change(job, patchBody) {
  await attempt(async () => {
    state.value = await patch(`/api/admin/jobs/${job.name}`, patchBody);
    toast('Schedule saved');
  });
}
async function runNow(job) {
  busy.value = job.name;
  await attempt(async () => {
    const r = await post('/api/admin/jobs/run', { name: job.name });
    state.value = r;
    toast(
      r.ran
        ? r.status === 'error'
          ? `${job.label} failed: ${r.error}`
          : r.status === 'partial'
            ? `${job.label}: started, the rest continues on the next requests`
            : `${job.label}: done`
        : `${job.label} is already running`,
    );
  });
  busy.value = '';
}
function resultText(j) {
  const r = j.result;
  if (!r) return '';
  if (r.summary) return r.summary;
  if (r.people === undefined) return '';
  return `${r.people} people checked, ${r.notified} notified (${r.slack} by Slack, ${r.email} by email)`;
}
function nextText(j) {
  if (!j.enabled) return 'Off';
  if (!j.next) return '';
  if (j.everyMinutes)
    return j.next.dueNow
      ? 'Due now: runs with the next request'
      : `${new Date(j.next.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} or later`;
  return j.next.dueNow ? 'Due now: runs with the next request' : `${j.next.date} at ${hh(j.next.hour)}`;
}
const STATUS = { running: 'Running', partial: 'Part done, continues on the next requests', done: 'Done', error: 'Failed' };
</script>
<template>
  <div class="card space-y-3 p-4">
    <h2 class="text-sm font-semibold">Scheduled jobs</h2>
    <p class="text-xs text-slate-500">
      There is no timer on this server: jobs run in the background when someone uses the app after the set time (checked at most once a
      minute), or when an external scheduler calls POST /api/admin/jobs/run with the JOBS_SECRET. Large teams are done in parts over a few
      requests.
    </p>
    <div>
      <label class="label" for="s-tz">Time zone for scheduled jobs (saved with Save settings)</label>
      <select id="s-tz" v-model="timeZone" class="input">
        <option v-for="z in zones" :key="z" :value="z">{{ z }}</option>
      </select>
    </div>
    <p v-if="state" class="text-xs text-slate-500">
      Time there now: {{ state.localNow }} ({{ state.timeZone }}).<span v-if="!state.auto">
        Request-triggered runs are off (JOBS_AUTO=off).</span
      >
    </p>
    <div v-for="j in state?.jobs || []" :key="j.name" class="space-y-2 rounded-lg border border-slate-200 p-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <label class="flex items-center gap-2 text-sm font-medium"
          ><input type="checkbox" :checked="j.enabled" @change="change(j, { enabled: $event.target.checked })" /> {{ j.label }}</label
        >
        <button type="button" class="btn" :disabled="busy === j.name" @click="runNow(j)">Run now</button>
      </div>
      <p v-if="j.everyMinutes" class="text-xs text-slate-600">
        Every {{ j.everyMinutes }} minutes while it is turned on in the settings above.
      </p>
      <div v-else class="flex flex-wrap gap-2">
        <select
          v-if="j.weekly"
          class="input w-36"
          :value="j.weekday"
          :aria-label="`${j.label} day`"
          @change="change(j, { weekday: Number($event.target.value) })"
        >
          <option v-for="(d, i) in DAYS" :key="d" :value="i">{{ d }}</option>
        </select>
        <select
          class="input w-28"
          :value="j.hour"
          :aria-label="`${j.label} time`"
          @change="change(j, { hour: Number($event.target.value) })"
        >
          <option v-for="h in HOURS" :key="h" :value="h">{{ hh(h) }}</option>
        </select>
        <span class="self-center text-xs text-slate-500">{{ j.weekly ? 'every week' : 'every day' }}</span>
      </div>
      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-slate-600">
        <dt class="text-slate-400">Last run</dt>
        <dd>{{ j.lastRunOn ? `${j.lastRunOn}${j.startedAt ? ` (${ago(j.startedAt)})` : ''}` : 'Never' }}</dd>
        <template v-if="j.status"
          ><dt class="text-slate-400">Result</dt>
          <dd>
            {{ STATUS[j.status] || j.status }}<span v-if="j.result">: {{ resultText(j) }}</span>
          </dd></template
        >
        <template v-if="j.error"
          ><dt class="text-slate-400">Error</dt>
          <dd class="break-words text-red-700">{{ j.error }}</dd></template
        >
        <dt class="text-slate-400">Next</dt>
        <dd>{{ nextText(j) }}</dd>
      </dl>
    </div>
  </div>
</template>
