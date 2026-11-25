<script setup>
// Timesheet > Time: one week of logged time (yours, one person's or the whole team's), its submission for
// approval, logging time and the billable flag. TimesheetView loads the week and owns the approve/reject dialog.
import { ref, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { get, post, del, session, toast, users as loadUsers } from '../../api.js';
import { fmtDate, ago } from '../../meta.js';
import { today as localToday, addDays, fmtHours } from '../../dates.js';
import { toCsv } from '../../csv.js';
import { downloadText } from '../../browser.js';
import TypeIcon from '../TypeIcon.vue';
import Avatar from '../Avatar.vue';
import Modal from '../Modal.vue';
import LoadState from '../LoadState.vue';
import { attempt } from '../../composables/useAction.js';
import { plural } from '../../plural.js';

const props = defineProps({
  data: { type: Object, default: null }, // GET /api/timesheet, null until it arrives
  loading: Boolean,
  loadError: { type: String, default: '' },
  load: { type: Function, required: true }, // reloads the week
  loadApprovals: { type: Function, required: true }, // reloads the weeks waiting for approval
  start: { type: String, required: true }, // Monday of the week
  who: { type: String, required: true }, // 'me', 'team' or a user id
});
const emit = defineEmits(['decide']); // (week, 'approve' | 'reject')
const route = useRoute();
const router = useRouter();
const today = localToday();
const people = ref([]);
const isAdmin = computed(() => session.user?.role === 'admin');
const log = ref(null); // { key, title, date, hours, note }
const addRow = ref(null); // { key }

// Weekly submission and approval (server/routes/timeTracking.js)
const busy = ref(false);
const sub = computed(() => props.data?.submission || null);
const locked = computed(() => Boolean(sub.value?.locked) && !isAdmin.value); // approved: only admins change work logs
const STATUS = {
  submitted: { label: 'Submitted', cls: 'bg-blue-100 text-blue-900' },
  approved: { label: 'Approved', cls: 'bg-green-100 text-green-900' },
  rejected: { label: 'Rejected', cls: 'bg-red-100 text-red-900' },
};
async function submitWeek() {
  busy.value = true;
  await attempt(async () => {
    await post('/api/timesheet/weeks', { week: props.start });
    toast('Week submitted for approval');
    await Promise.all([props.load(), props.loadApprovals()]);
  });
  busy.value = false;
}
async function withdrawWeek() {
  busy.value = true;
  await attempt(async () => {
    await del(`/api/timesheet/weeks/${sub.value.id}`);
    toast('Submission withdrawn');
    await Promise.all([props.load(), props.loadApprovals()]);
  });
  busy.value = false;
}
const askDecision = (week, verb) => emit('decide', week, verb);
watch(
  isAdmin,
  async (a) => {
    if (a) people.value = await loadUsers();
  },
  { immediate: true },
);

const go = (q) => router.replace({ query: { ...route.query, ...q } });
const shift = (weeks) => go({ week: addDays(props.start, weeks * 7) });
const dayLabel = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', timeZone: 'UTC' });
const fmt = (h) => (h ? fmtHours(h) : '');
const team = computed(() => props.who === 'team');
const mine = computed(() => props.who === 'me' || props.who === session.user?.id);
const rows = computed(() => (team.value ? props.data?.byUser : props.data?.byIssue) || []);

function openLog(row, date) {
  if (!mine.value || team.value) return;
  if (locked.value) {
    toast('This week is approved and locked', 'warn');
    return;
  }
  log.value = { key: row.key, title: row.title, date, hours: '', note: '', billable: true };
}
async function saveLog() {
  await attempt(async () => {
    await post(`/api/issues/${log.value.key}/worklogs`, {
      hours: Number(log.value.hours),
      workDate: log.value.date,
      note: log.value.note,
      billable: log.value.billable !== false,
    });
    toast(`Logged ${log.value.hours}h on ${log.value.key}`);
    log.value = null;
    await props.load();
  });
}
async function startAddRow() {
  const key = String(addRow.value.key || '')
    .trim()
    .toUpperCase();
  if (!key) return;
  await attempt(async () => {
    const { issue } = await get(`/api/issues/${key}`);
    addRow.value = null;
    log.value = {
      key: issue.key,
      title: issue.title,
      date: today >= props.start && today <= addDays(props.start, 6) ? today : props.start,
      hours: '',
      note: '',
      billable: true,
    };
  });
}
// Billable flag: tick entries, then mark them billable or not (your own; admins: anyone's)
const picked = ref(new Set());
const showEntries = ref(false);
const canMark = (e) => e.user.id === session.user?.id || isAdmin.value;
const markable = computed(() => (props.data?.entries || []).filter(canMark));
function togglePick(id) {
  const s = new Set(picked.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  picked.value = s;
}
async function markBillable(billable) {
  const ids = [...picked.value];
  await attempt(async () => {
    for (let i = 0; i < ids.length; i += 90) await post('/api/worklogs/billable', { ids: ids.slice(i, i + 90), billable });
    toast(`${ids.length} ${plural(ids.length, 'entry', 'entries')} marked ${billable ? 'billable' : 'non-billable'}`);
    picked.value = new Set();
    await props.load();
  });
}
watch(
  () => [props.start, props.who],
  () => {
    picked.value = new Set();
  },
);
function downloadCsv() {
  const rows = [['Date', 'Person', 'Issue', 'Title', 'Project', 'Hours', 'Billable', 'Note']];
  for (const e of props.data.entries)
    rows.push([e.date, e.user.name, e.key, e.title, e.projectKey, e.hours, e.billable === false ? 'No' : 'Yes', e.note]);
  downloadText(`timesheet-${props.start}.csv`, toCsv(rows), 'text/csv');
}
</script>

<template>
  <div class="mb-4 flex flex-wrap items-center gap-2">
    <div class="flex items-center gap-1">
      <button class="btn btn-sm" aria-label="Previous week" @click="shift(-1)">‹</button>
      <button class="btn btn-sm" @click="go({ week: undefined })">This week</button>
      <button class="btn btn-sm" aria-label="Next week" @click="shift(1)">›</button>
    </div>
    <span class="text-sm text-slate-600">{{ fmtDate(start) }} to {{ fmtDate(addDays(start, 6)) }}</span>
    <div class="ml-auto flex flex-wrap items-center gap-2">
      <select
        v-if="isAdmin"
        :value="who"
        class="input w-48 py-1"
        aria-label="Whose time"
        @change="go({ user: $event.target.value === 'me' ? undefined : $event.target.value })"
      >
        <option value="me">My time</option>
        <option value="team">Whole team</option>
        <option v-for="u in people.filter((p) => p.id !== session.user.id)" :key="u.id" :value="u.id">{{ u.name }}</option>
      </select>
      <button class="btn btn-sm" :disabled="!data?.entries.length" @click="downloadCsv">Export CSV</button>
    </div>
  </div>

  <div v-if="data && !team && (sub || data.canSubmit)" class="card mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 p-3 text-sm">
    <span v-if="sub" class="chip" :class="STATUS[sub.status].cls">{{ STATUS[sub.status].label }}</span>
    <span v-if="!sub" class="text-slate-700">This week is not submitted for approval yet.</span>
    <span v-else-if="sub.status === 'submitted'" class="text-slate-700">Submitted {{ ago(sub.submittedAt) }}, waiting for approval.</span>
    <span v-else-if="sub.status === 'approved'" class="text-slate-700"
      >Approved by {{ sub.decidedBy?.name || 'a former user' }} {{ ago(sub.decidedAt)
      }}<template v-if="sub.comment">: {{ sub.comment }}</template
      >. The week is locked: its work logs can only be changed by a workspace admin.</span
    >
    <span v-else class="text-slate-700"
      >Rejected by {{ sub.decidedBy?.name || 'a former user' }} {{ ago(sub.decidedAt) }}: {{ sub.comment
      }}<template v-if="data.canSubmit"> (change the week, then submit it again)</template></span
    >
    <div class="ml-auto flex flex-wrap gap-2">
      <button
        v-if="data.canSubmit && (!sub || sub.status === 'rejected')"
        class="btn btn-sm btn-primary"
        :disabled="busy"
        @click="submitWeek"
      >
        {{ sub ? 'Submit again' : 'Submit week' }}
      </button>
      <button v-if="data.canSubmit && sub?.status === 'submitted'" class="btn btn-sm" :disabled="busy" @click="withdrawWeek">
        Withdraw
      </button>
      <template v-if="isAdmin && sub?.status === 'submitted'">
        <button class="btn btn-sm btn-danger" @click="askDecision(sub, 'reject')">Reject</button>
        <button class="btn btn-sm btn-primary" @click="askDecision(sub, 'approve')">Approve</button>
      </template>
      <button v-if="isAdmin && sub?.status === 'approved'" class="btn btn-sm" @click="askDecision(sub, 'reject')">Reopen</button>
    </div>
  </div>

  <LoadState v-if="!data" :loading="loading" :error="loadError" card :rows="4" @retry="load" />
  <template v-else-if="data">
    <div class="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
      <div class="card p-3">
        <div class="text-2xl font-semibold">{{ fmt(data.total) || 0 }}h</div>
        <div class="text-xs text-slate-500">This week</div>
      </div>
      <div class="card p-3">
        <div class="text-2xl font-semibold">{{ fmt(data.total / 5) || 0 }}h</div>
        <div class="text-xs text-slate-500">
          Average per weekday<span v-if="data.nonBillable">, {{ fmt(data.nonBillable) }}h non-billable this week</span>
        </div>
      </div>
      <div class="card col-span-2 p-3">
        <div class="mb-1 text-xs text-slate-500">By project</div>
        <div v-if="!data.byProject.length" class="text-sm text-slate-400">No time logged</div>
        <div v-for="p in data.byProject" :key="p.key" class="flex items-center gap-2 text-sm">
          <span class="w-14 font-medium">{{ p.key }}</span>
          <div class="h-2 flex-1 rounded-full bg-slate-100">
            <div class="h-2 rounded-full bg-accent" :style="{ width: `${(p.total / data.total) * 100}%` }"></div>
          </div>
          <span class="w-12 text-right">{{ fmt(p.total) }}h</span>
        </div>
      </div>
    </div>

    <div class="card overflow-x-auto">
      <table class="w-full min-w-[44rem] text-sm">
        <thead class="bg-slate-50 text-xs uppercase text-slate-500">
          <tr>
            <th class="px-3 py-2 text-left">{{ team ? 'Person' : 'Issue' }}</th>
            <th v-for="d in data.days" :key="d" class="w-16 px-1 py-2 text-center" :class="d === today ? 'text-blue-800' : ''">
              {{ dayLabel(d) }}
            </th>
            <th class="w-16 px-3 py-2 text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.key || r.id" class="border-t border-slate-100">
            <td class="px-3 py-1.5">
              <div v-if="team" class="flex items-center gap-2"><Avatar :user="r" :size="22" label="full" /></div>
              <RouterLink v-else :to="`/browse/${r.key}`" class="flex min-w-0 items-center gap-2 hover:underline">
                <TypeIcon :type="r.type" /><span class="shrink-0 font-medium text-slate-600">{{ r.key }}</span
                ><span class="truncate">{{ r.title }}</span>
              </RouterLink>
            </td>
            <td v-for="d in data.days" :key="d" class="px-1 py-1 text-center">
              <button
                v-if="!team && mine"
                class="h-8 w-full rounded-md text-sm hover:bg-blue-50"
                :class="r.perDay[d] ? 'bg-slate-100 font-medium' : 'text-slate-300'"
                :aria-label="
                  r.perDay[d] ? `${fmt(r.perDay[d])} hours on ${r.key} for ${d}. Log more time` : `Log time on ${r.key} for ${d}`
                "
                @click="openLog(r, d)"
              >
                {{ fmt(r.perDay[d]) || '+' }}
              </button>
              <span v-else :class="r.perDay[d] ? 'font-medium' : 'text-slate-300'">{{ fmt(r.perDay[d]) || '·' }}</span>
            </td>
            <td class="px-3 py-1.5 text-right font-semibold">{{ fmt(r.total) }}</td>
          </tr>
          <tr v-if="!rows.length">
            <td :colspan="data.days.length + 2" class="px-3 py-10 text-center text-slate-500">
              No time logged this week.<span v-if="mine && !team"> Add an issue below, or use Log work on any issue.</span>
            </td>
          </tr>
        </tbody>
        <tfoot class="border-t-2 border-slate-200 font-semibold">
          <tr>
            <td class="px-3 py-2">Total</td>
            <td v-for="d in data.days" :key="d" class="px-1 py-2 text-center">{{ fmt(data.perDay[d]) }}</td>
            <td class="px-3 py-2 text-right">{{ fmt(data.total) || 0 }}</td>
          </tr>
        </tfoot>
      </table>
    </div>
    <form
      v-if="mine && !team && !locked"
      class="mt-3 flex flex-wrap items-center gap-2"
      @submit.prevent="addRow ? startAddRow() : (addRow = { key: '' })"
    >
      <input v-if="addRow" v-model="addRow.key" class="input w-40 uppercase" placeholder="Issue key, e.g. WEB-12" autofocus />
      <button class="btn btn-sm">{{ addRow ? 'Log time on it' : '+ Log time on another issue' }}</button>
      <button v-if="addRow" type="button" class="btn btn-sm btn-ghost" @click="addRow = null">Cancel</button>
    </form>

    <section v-if="markable.length" class="card mt-3 p-3" aria-labelledby="ts-entries">
      <div class="flex flex-wrap items-center gap-2">
        <h2 id="ts-entries" class="text-sm font-semibold">Billable</h2>
        <button class="btn btn-sm" :aria-expanded="showEntries" @click="showEntries = !showEntries">
          {{ showEntries ? 'Hide entries' : 'Choose entries' }}
        </button>
        <template v-if="showEntries">
          <button class="btn btn-sm" :disabled="!picked.size" @click="markBillable(false)">Mark non-billable</button>
          <button class="btn btn-sm" :disabled="!picked.size" @click="markBillable(true)">Mark billable</button>
          <span class="text-xs text-slate-500">{{ picked.size }} chosen</span>
        </template>
      </div>
      <p class="mt-1 text-xs text-slate-500">
        Billable work counts against a project's budget. Work is billable unless you mark it otherwise.
      </p>
      <ul v-if="showEntries" class="mt-2 divide-y divide-slate-100 text-sm">
        <li v-for="e in markable" :key="e.id" class="flex flex-wrap items-center gap-2 py-1.5">
          <input :id="`ts-e-${e.id}`" type="checkbox" :checked="picked.has(e.id)" @change="togglePick(e.id)" />
          <label :for="`ts-e-${e.id}`" class="flex min-w-0 flex-1 flex-wrap gap-x-2">
            <span class="w-24 text-slate-600">{{ fmtDate(e.date) }}</span>
            <span class="font-medium text-slate-600">{{ e.key }}</span>
            <span class="min-w-0 flex-1 truncate">{{ e.title }}</span>
            <span v-if="team" class="text-slate-600">{{ e.user.name }}</span>
            <span class="w-12 text-right">{{ fmt(e.hours) }}h</span>
          </label>
          <span class="chip" :class="e.billable === false ? 'bg-slate-100 text-slate-700' : 'bg-green-100 text-green-900'">{{
            e.billable === false ? 'Non-billable' : 'Billable'
          }}</span>
        </li>
      </ul>
    </section>
  </template>

  <Modal v-if="log" :title="`Log time on ${log.key}`" @close="log = null">
    <form id="ts-log" class="space-y-3" @submit.prevent="saveLog">
      <p class="text-sm text-slate-600">{{ log.title }}</p>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="label" for="ts-hours">Hours</label
          ><input id="ts-hours" v-model="log.hours" type="number" min="0.25" max="24" step="0.25" class="input" required autofocus />
        </div>
        <div>
          <label class="label" for="ts-date">Date</label><input id="ts-date" v-model="log.date" type="date" class="input" required />
        </div>
      </div>
      <div>
        <label class="label" for="ts-note">What did you do? (optional)</label
        ><input id="ts-note" v-model="log.note" class="input" maxlength="2000" />
      </div>
      <label class="flex items-center gap-2 text-sm"><input v-model="log.billable" type="checkbox" /> Billable</label>
    </form>
    <template #footer
      ><button class="btn" @click="log = null">Cancel</button><button class="btn btn-primary" form="ts-log">Log time</button></template
    >
  </Modal>
</template>
