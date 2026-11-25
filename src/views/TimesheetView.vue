<script setup>
// Timesheet page: the heading, the Time and Approvals tabs and what both share (the week's data, the weeks
// waiting for approval and the approve/reject dialog). The tabs are components/timesheet/.
import { ref, computed } from 'vue';
import { useRoute } from 'vue-router';
import { get, post, toast } from '../api.js';
import { fmtDate } from '../meta.js';
import { today as localToday, addDays, mondayOf } from '../dates.js';
import Modal from '../components/Modal.vue';
import TimesheetWeek from '../components/timesheet/TimesheetWeek.vue';
import TimesheetApprovals from '../components/timesheet/TimesheetApprovals.vue';
import { attempt } from '../composables/useAction.js';
import { useLoad } from '../composables/useLoad.js';

const route = useRoute();
const today = localToday();
const start = computed(() => mondayOf(String(route.query.week || today)));
const who = computed(() => String(route.query.user || 'me'));

const {
  data,
  loading,
  error: loadError,
  reload: load,
} = useLoad(
  () => get(`/api/timesheet?from=${start.value}&to=${addDays(start.value, 6)}&user=${encodeURIComponent(who.value)}`),
  [start, who],
);

// Weekly submission and approval (server/routes/timeTracking.js)
const approvalsTab = computed(() => route.name === 'timesheet-approvals');
const approvals = ref(null); // submitted weeks waiting for me
const decision = ref(null); // { week, verb: 'approve' | 'reject', comment }
const busy = ref(false);
async function loadApprovals() {
  try {
    approvals.value = (await get('/api/timesheet/approvals')).weeks;
  } catch (e) {
    approvals.value = [];
    toast(e.message, 'error');
  }
}
loadApprovals();
const askDecision = (week, verb) => {
  decision.value = { week, verb, comment: '' };
};
async function decide() {
  const d = decision.value;
  busy.value = true;
  await attempt(async () => {
    await post(`/api/timesheet/weeks/${d.week.id}/${d.verb}`, { comment: d.comment });
    toast(d.verb === 'approve' ? 'Week approved' : d.week.status === 'approved' ? 'Week reopened' : 'Week rejected');
    decision.value = null;
    await Promise.all([load(), loadApprovals()]);
  });
  busy.value = false;
}
</script>

<template>
  <div class="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
    <h1 class="text-xl font-semibold">Timesheet</h1>
    <nav class="flex gap-1 border-b border-slate-200" aria-label="Timesheet sections">
      <RouterLink
        :to="{ path: '/timesheet', query: route.query }"
        class="px-3 py-1.5 text-sm"
        :class="approvalsTab ? 'text-slate-600' : 'border-b-2 border-blue-700 font-semibold text-blue-800'"
        :aria-current="approvalsTab ? undefined : 'page'"
        >Time</RouterLink
      >
      <RouterLink
        :to="{ path: '/timesheet/approvals', query: route.query }"
        class="px-3 py-1.5 text-sm"
        :class="approvalsTab ? 'border-b-2 border-blue-700 font-semibold text-blue-800' : 'text-slate-600'"
        :aria-current="approvalsTab ? 'page' : undefined"
        >Approvals<span v-if="approvals?.length" class="chip ml-1.5 bg-accent text-white"
          >{{ approvals.length }}<span class="sr-only"> waiting</span></span
        ></RouterLink
      >
    </nav>
  </div>

  <TimesheetApprovals v-if="approvalsTab" :approvals="approvals" @decide="askDecision" />
  <TimesheetWeek
    v-else
    :data="data"
    :loading="loading"
    :load-error="loadError"
    :load="load"
    :load-approvals="loadApprovals"
    :start="start"
    :who="who"
    @decide="askDecision"
  />

  <Modal
    v-if="decision"
    :title="
      decision.verb === 'approve' ? 'Approve this week' : decision.week.status === 'approved' ? 'Reopen this week' : 'Reject this week'
    "
    @close="decision = null"
  >
    <form id="ts-decide" class="space-y-3" @submit.prevent="decide">
      <p class="text-sm text-slate-700">
        <template v-if="decision.week.user">{{ decision.week.user.name }}: </template>{{ fmtDate(decision.week.weekStart) }} to
        {{ fmtDate(decision.week.weekEnd) }}
      </p>
      <p class="text-sm text-slate-600">
        {{
          decision.verb === 'approve'
            ? 'Approving locks the week: its work logs can then only be changed by a workspace admin.'
            : 'The person is told why, can change the week and submit it again.'
        }}
      </p>
      <div>
        <label class="label" for="ts-decide-comment">{{
          decision.verb === 'approve' ? 'Comment (optional)' : 'Why? (sent to the person)'
        }}</label>
        <textarea
          id="ts-decide-comment"
          v-model="decision.comment"
          class="input"
          rows="3"
          maxlength="1000"
          :required="decision.verb === 'reject'"
          autofocus
        ></textarea>
      </div>
    </form>
    <template #footer
      ><button class="btn" @click="decision = null">Cancel</button
      ><button class="btn" :class="decision.verb === 'approve' ? 'btn-primary' : 'btn-danger'" form="ts-decide" :disabled="busy">
        {{ decision.verb === 'approve' ? 'Approve' : decision.week.status === 'approved' ? 'Reopen' : 'Reject' }}
      </button></template
    >
  </Modal>
</template>
