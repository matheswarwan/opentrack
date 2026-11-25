<script setup>
// Weekly capacity hours and time off for one person (yourself, or anyone for admins). Used on the Capacity page.
import { ref, reactive, watch } from 'vue';
import { get, put, post, del, toast } from '../api.js';
import { fmtDate } from '../meta.js';
import { attempt } from '../composables/useAction.js';

const props = defineProps({ userId: { type: String, default: 'me' } });
const emit = defineEmits(['changed']);
const data = ref(null);
const hours = ref('');
const off = reactive({ startDate: '', endDate: '', note: '' });
const uid = Math.random().toString(36).slice(2, 8); // unique ids for labels when two editors are on the page
const base = () => `/api/capacity/people/${props.userId}`;

async function load() {
  await attempt(async () => {
    data.value = await get(base());
    hours.value = data.value.custom ? data.value.weeklyHours : '';
  });
}
watch(() => props.userId, load, { immediate: true });

async function saveHours() {
  await attempt(async () => {
    await put(base(), { weeklyHours: hours.value === '' || hours.value === null ? null : Number(hours.value) });
    toast('Weekly hours saved');
    await load();
    emit('changed');
  });
}
async function addOff() {
  await attempt(async () => {
    await post(`${base()}/time-off`, { startDate: off.startDate, endDate: off.endDate || off.startDate, note: off.note });
    Object.assign(off, { startDate: '', endDate: '', note: '' });
    toast('Time off added');
    await load();
    emit('changed');
  });
}
async function removeOff(t) {
  await attempt(async () => {
    await del(`/api/capacity/time-off/${t.id}`);
    await load();
    emit('changed');
  });
}
</script>

<template>
  <div v-if="data" class="space-y-4">
    <form class="flex flex-wrap items-end gap-2" @submit.prevent="saveHours">
      <div>
        <label class="label" :for="`ce-hours-${uid}`">Weekly hours</label>
        <input
          :id="`ce-hours-${uid}`"
          v-model="hours"
          type="number"
          min="0"
          max="100"
          step="0.5"
          class="input w-28"
          :placeholder="String(data.defaultHours)"
          :aria-describedby="`ce-hours-help-${uid}`"
        />
      </div>
      <button class="btn btn-sm">Save</button>
      <p :id="`ce-hours-help-${uid}`" class="w-full text-xs text-slate-600">
        Empty uses the workspace default ({{ data.defaultHours }} h). A weekday counts a fifth of the weekly hours; weekends count 0.
      </p>
    </form>

    <div>
      <h3 class="text-sm font-semibold">Time off</h3>
      <ul v-if="data.timeOff.length" class="mt-1 divide-y divide-slate-100 text-sm">
        <li v-for="t in data.timeOff" :key="t.id" class="flex flex-wrap items-center gap-2 py-1.5">
          <span
            >{{ fmtDate(t.startDate) }}<template v-if="t.endDate !== t.startDate"> to {{ fmtDate(t.endDate) }}</template></span
          >
          <span v-if="t.note" class="min-w-0 flex-1 truncate text-slate-600">{{ t.note }}</span>
          <button class="btn btn-sm btn-ghost ml-auto" :aria-label="`Remove time off from ${t.startDate}`" @click="removeOff(t)">
            Remove
          </button>
        </li>
      </ul>
      <p v-else class="mt-1 text-sm text-slate-600">No time off planned.</p>
      <form class="mt-2 grid gap-2 sm:grid-cols-[auto_auto_1fr_auto] sm:items-end" @submit.prevent="addOff">
        <div>
          <label class="label" :for="`ce-from-${uid}`">From</label
          ><input :id="`ce-from-${uid}`" v-model="off.startDate" type="date" class="input" required />
        </div>
        <div>
          <label class="label" :for="`ce-to-${uid}`">To</label
          ><input :id="`ce-to-${uid}`" v-model="off.endDate" type="date" class="input" :min="off.startDate" />
        </div>
        <div>
          <label class="label" :for="`ce-note-${uid}`">Note (only you and admins see it)</label
          ><input :id="`ce-note-${uid}`" v-model="off.note" class="input" maxlength="200" />
        </div>
        <button class="btn btn-sm">Add time off</button>
      </form>
    </div>
  </div>
</template>
