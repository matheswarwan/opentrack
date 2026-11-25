<script setup>
// Issue page > Work log tab: the logged hours, Log work and delete.
import { ref } from 'vue';
import { post, del } from '../api.js';
import { fmtDate } from '../meta.js';
import { today } from '../dates.js';
import { attempt } from '../composables/useAction.js';

const props = defineProps({ issue: { type: Object, required: true }, canEdit: Boolean, canAdmin: Boolean });
const emit = defineEmits(['changed']); // a work log was added or deleted
const logForm = ref(null);

async function addLog() {
  await attempt(() => post(`/api/issues/${props.issue.key}/worklogs`, { ...logForm.value, hours: Number(logForm.value.hours) }), {
    then: () => {
      logForm.value = null;
      emit('changed');
    },
  });
}
async function removeLog(w) {
  await attempt(() => del(`/api/worklogs/${w.id}`), { then: () => emit('changed') }); // fails when e.g. the week is approved and locked
}
</script>
<template>
  <div>
    <button
      v-if="canEdit && !logForm"
      class="btn btn-sm mb-3"
      @click="logForm = { hours: '', workDate: today(), note: '', billable: true }"
    >
      Log work
    </button>
    <form v-if="logForm" class="mb-3 grid grid-cols-[6rem_10rem_1fr_auto] gap-2" @submit.prevent="addLog">
      <input
        v-model="logForm.hours"
        aria-label="Hours"
        type="number"
        step="0.25"
        min="0.25"
        max="24"
        class="input"
        placeholder="Hours"
        required
        autofocus
      />
      <input v-model="logForm.workDate" aria-label="Date worked" type="date" class="input" required />
      <input v-model="logForm.note" class="input" aria-label="Work log note" placeholder="What did you do?" />
      <div class="flex gap-1">
        <button class="btn btn-primary">Save</button><button type="button" class="btn" @click="logForm = null">Cancel</button>
      </div>
      <label class="col-span-4 flex items-center gap-2 text-sm"
        ><input v-model="logForm.billable" type="checkbox" /> Billable (counts against the project budget)</label
      >
    </form>
    <div v-for="w in issue.worklogs" :key="w.id" class="flex items-center gap-3 border-b border-slate-100 py-1.5 text-sm">
      <span class="w-12 font-semibold">{{ w.hours }}h</span><span class="w-28 text-slate-500">{{ fmtDate(w.workDate) }}</span
      ><span class="w-32">{{ w.user.name }}</span
      ><span
        v-if="w.source === 'mcp'"
        class="chip bg-violet-100 text-violet-900"
        title="Made by an AI assistant (MCP) acting for this person"
        >via AI assistant</span
      ><span class="flex-1 text-slate-600"
        >{{ w.note }}<span v-if="w.billable === false" class="chip ml-2 bg-slate-100 text-slate-700">Non-billable</span></span
      >
      <button v-if="w.mine || canAdmin" class="text-slate-400 hover:text-red-700" aria-label="Delete work log" @click="removeLog(w)">
        ×
      </button>
    </div>
    <p v-if="!issue.worklogs.length" class="text-sm text-slate-400">No work logged.</p>
  </div>
</template>
