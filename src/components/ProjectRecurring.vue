<script setup>
// Project settings > Recurring (and the project's Recurring tab for members): rules that create an issue on a schedule.
// Project admins manage every rule; members manage their own. The daily job creates the issues (server/lib/recurring.js).
import { ref, watch, computed } from 'vue';
import { useRoute } from 'vue-router';
import { get, post, patch, toast } from '../api.js';
import { TYPES, PRIORITIES, typeOf, fmtDate } from '../meta.js';
import { today } from '../dates.js';
import UserSelect from './UserSelect.vue';
import LabelsInput from './LabelsInput.vue';
import MarkdownEditor from './MarkdownEditor.vue';
import Icon from './Icon.vue';
import { attempt } from '../composables/useAction.js';
import { useCrud } from '../composables/useCrud.js';
import { plural } from '../plural.js';

const props = defineProps({ projectKey: { type: String, required: true } });
const route = useRoute();
const canCreate = ref(false);
const templates = ref([]);
const preview = ref(null);
const history = ref({}); // rule id -> runs
const openHistory = ref(null);
const base = () => `/api/projects/${props.projectKey}/recurring`;
const DAYS = [
  [1, 'Mon'],
  [2, 'Tue'],
  [3, 'Wed'],
  [4, 'Thu'],
  [5, 'Fri'],
  [6, 'Sat'],
  [0, 'Sun'],
];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const canHaveSubtasks = (type) => ['story', 'task', 'bug'].includes(type);
const crud = useCrud({
  base,
  list: (r) => r.rules,
  loaded: async (r) => {
    canCreate.value = r.canCreate;
    templates.value = (await get(`/api/projects/${props.projectKey}/templates`)).templates;
    const want = route.query.rule;
    if (want && rules.value.some((x) => x.id === want) && openHistory.value !== want) toggleHistory(want);
  },
  blank: formFor,
  body: () => ({
    name: form.name,
    title: form.title,
    type: form.type,
    priority: form.priority,
    assigneeId: form.assigneeId || null,
    labels: form.labels,
    templateId: form.templateId || null,
    description: form.description,
    subtasks: canHaveSubtasks(form.type)
      ? form.subtasks
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
    sprint: form.sprint,
    dueDays: form.dueDays === '' ? null : Number(form.dueDays),
    schedule: schedule.value,
    ...limits.value,
    paused: form.paused,
  }),
  saved: 'Recurring rule saved',
});
const { items: rules, editing, form, busy, load, edit, save } = crud;
watch(() => props.projectKey, load, { immediate: true });

function formFor(r) {
  const s = r?.schedule || { freq: 'weekly', weekdays: [1] };
  return {
    name: r?.name || '',
    title: r?.title || '',
    type: r?.type || 'task',
    priority: r?.priority || 'medium',
    assigneeId: r?.assignee?.id || null,
    labels: [...(r?.labels || [])],
    templateId: r?.templateId || '',
    description: r?.description || '',
    subtasks: (r?.subtasks || []).join('\n'),
    sprint: r?.sprint || 'backlog',
    dueDays: r?.dueDays ?? '',
    freq: s.freq,
    weekdaysOnly: Boolean(s.weekdaysOnly),
    weekdays: [...(s.weekdays || [1])],
    monthly: s.monthly || 'day',
    day: s.day || 1,
    month: s.month || 1,
    startDate: r?.startDate || today(),
    ends: r?.endDate ? 'date' : r?.maxCount ? 'count' : 'never',
    endDate: r?.endDate || '',
    maxCount: r?.maxCount || 10,
    paused: Boolean(r?.paused),
  };
}
const schedule = computed(() => {
  if (form.freq === 'daily') return { freq: 'daily', weekdaysOnly: form.weekdaysOnly };
  if (form.freq === 'weekly') return { freq: 'weekly', weekdays: form.weekdays };
  if (form.freq === 'monthly')
    return form.monthly === 'day' ? { freq: 'monthly', monthly: 'day', day: Number(form.day) } : { freq: 'monthly', monthly: form.monthly };
  return { freq: 'yearly', month: Number(form.month), day: Number(form.day) };
});
const limits = computed(() => ({
  startDate: form.startDate || null,
  endDate: form.ends === 'date' ? form.endDate || null : null,
  maxCount: form.ends === 'count' ? Number(form.maxCount) || null : null,
}));
let timer = null;
watch(
  () => editing.value && JSON.stringify([schedule.value, limits.value]),
  (sig) => {
    clearTimeout(timer);
    if (!sig) return;
    timer = setTimeout(async () => {
      try {
        preview.value = await post(`${base()}/preview`, { schedule: schedule.value, ...limits.value });
      } catch (e) {
        preview.value = { error: e.message };
      }
    }, 250);
  },
  { immediate: true },
);
const previewLine = computed(() => {
  const p = preview.value;
  if (!p) return '';
  if (p.error) return p.error;
  return p.dates.length ? `${p.summary}, next on ${fmtDate(p.dates[0])}` : `${p.summary}. No dates left.`;
});
function toggleDay(d) {
  form.weekdays = form.weekdays.includes(d) ? form.weekdays.filter((x) => x !== d) : [...form.weekdays, d];
}

async function setPaused(r, paused) {
  await attempt(async () => {
    await patch(`${base()}/${r.id}`, { paused });
    await load();
    toast(paused ? `${r.name} paused` : `${r.name} resumed`);
  });
}
const remove = (r) => crud.remove(r, `Delete the recurring rule "${r.name}"? Issues it already made are kept.`);
async function toggleHistory(id) {
  if (openHistory.value === id) {
    openHistory.value = null;
    return;
  }
  openHistory.value = id;
  await attempt(async () => {
    history.value = { ...history.value, [id]: (await get(`${base()}/${id}`)).runs };
  });
}
const statusText = (r) => (r.paused ? 'Paused' : r.ended ? 'Ended' : `Next on ${fmtDate(r.nextOn)}`);
</script>

<template>
  <div class="card p-4">
    <div class="mb-2 flex flex-wrap items-center gap-2">
      <h2 class="text-sm font-semibold">Recurring issues</h2>
      <button v-if="canCreate" class="btn btn-sm btn-primary ml-auto" :disabled="busy" @click="edit(null)">New rule</button>
    </div>
    <p class="mb-2 text-xs text-slate-500">
      A rule creates an issue on a schedule, early each morning (workspace time zone). Missed days are made up for up to 7 days back.
      Project admins manage every rule; members manage their own.
    </p>

    <div
      v-for="r in rules"
      :key="r.id"
      class="border-b border-slate-100 py-2 text-sm"
      :class="route.query.rule === r.id ? 'bg-amber-50' : ''"
    >
      <div class="flex flex-wrap items-center gap-2">
        <Icon name="repeat" :size="15" class="shrink-0 text-slate-500" />
        <span class="min-w-0 flex-1"
          ><strong>{{ r.name }}</strong> <span class="text-xs text-slate-500">{{ typeOf(r.type).label }}, {{ r.summary }}</span></span
        >
        <span class="chip" :class="r.paused || r.ended ? 'bg-slate-200 text-slate-600' : 'bg-green-100 text-green-800'">{{
          statusText(r)
        }}</span>
      </div>
      <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-xs text-slate-500">
        <span>{{ r.createdCount }} {{ plural(r.createdCount, 'issue') }} made</span>
        <span v-if="r.createdBy">by {{ r.createdBy.name }}</span>
        <button class="link" @click="toggleHistory(r.id)">{{ openHistory === r.id ? 'Hide history' : 'History' }}</button>
        <template v-if="r.canManage">
          <button class="link" @click="edit(r)">Edit</button>
          <button class="link" @click="setPaused(r, !r.paused)">{{ r.paused ? 'Resume' : 'Pause' }}</button>
          <button class="text-slate-500 hover:text-red-700" @click="remove(r)">Delete</button>
        </template>
      </div>
      <div v-if="openHistory === r.id" class="mt-2 pl-6">
        <p v-if="!history[r.id]" class="text-xs text-slate-400">Loading</p>
        <p v-else-if="!history[r.id].length" class="text-xs text-slate-500">No issues made yet.</p>
        <ul v-else class="space-y-0.5 text-xs">
          <li v-for="h in history[r.id]" :key="h.date" class="flex gap-2">
            <span class="w-24 shrink-0 text-slate-500">{{ fmtDate(h.date) }}</span>
            <RouterLink v-if="!h.gone" :to="`/browse/${h.key}`" class="link">{{ h.key }}</RouterLink><span
              v-else
              class="text-slate-400 line-through"
              title="Deleted"
              >{{ h.key }}</span
            >
            <span class="truncate text-slate-600">{{ h.title }}</span>
          </li>
        </ul>
      </div>
    </div>
    <p v-if="!rules.length && !editing" class="py-2 text-sm text-slate-500">No recurring rules yet.</p>

    <form v-if="editing" class="mt-3 grid gap-3 rounded-md bg-slate-50 p-3 sm:grid-cols-2" @submit.prevent="save">
      <div>
        <label class="label" for="rr-name">Rule name</label
        ><input id="rr-name" v-model="form.name" class="input" maxlength="80" placeholder="e.g. Weekly ops check" />
      </div>
      <div>
        <label class="label" for="rr-title">Issue summary</label
        ><input id="rr-title" v-model="form.title" class="input" maxlength="255" required placeholder="e.g. Ops check {date}" />
        <p class="mt-1 text-xs text-slate-500">You can use {date}, {month}, {year} and {week}.</p>
      </div>
      <div>
        <label class="label" for="rr-type">Issue type</label>
        <select id="rr-type" v-model="form.type" class="input">
          <option v-for="t in TYPES.filter((x) => x.id !== 'subtask')" :key="t.id" :value="t.id">{{ t.label }}</option>
        </select>
      </div>
      <div>
        <label class="label" for="rr-priority">Priority</label>
        <select id="rr-priority" v-model="form.priority" class="input">
          <option v-for="p in PRIORITIES" :key="p.id" :value="p.id">{{ p.label }}</option>
        </select>
      </div>
      <div><label class="label">Assignee</label><UserSelect v-model="form.assigneeId" /></div>
      <div>
        <label class="label" for="rr-tpl">Template</label>
        <select id="rr-tpl" v-model="form.templateId" class="input">
          <option value="">None</option>
          <option v-for="t in templates" :key="t.id" :value="t.id">{{ t.name }}</option>
        </select>
      </div>
      <div>
        <label class="label" for="rr-sprint">Put it in</label>
        <select id="rr-sprint" v-model="form.sprint" class="input">
          <option value="backlog">The backlog</option>
          <option value="active">The active sprint (else the backlog)</option>
        </select>
      </div>
      <div>
        <label class="label" for="rr-due">Due after (days)</label
        ><input id="rr-due" v-model="form.dueDays" type="number" min="0" max="365" class="input" placeholder="No due date" />
      </div>
      <div class="sm:col-span-2"><label class="label">Labels</label><LabelsInput v-model="form.labels" /></div>
      <div class="sm:col-span-2">
        <label class="label">Description (Markdown)</label><MarkdownEditor v-model="form.description" :rows="4" />
      </div>
      <div v-if="canHaveSubtasks(form.type)" class="sm:col-span-2">
        <label class="label" for="rr-subs">Sub-tasks to create (one per line, added to the template's)</label>
        <textarea id="rr-subs" v-model="form.subtasks" class="input" rows="3"></textarea>
      </div>

      <fieldset class="space-y-2 rounded-md border border-slate-200 bg-white p-3 sm:col-span-2">
        <legend class="px-1 text-xs font-semibold text-slate-600">Schedule</legend>
        <div class="flex flex-wrap items-center gap-2">
          <label class="text-sm" for="rr-freq">Repeat</label>
          <select id="rr-freq" v-model="form.freq" class="input w-auto">
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
          </select>
          <label v-if="form.freq === 'daily'" class="flex items-center gap-1 text-sm"
            ><input v-model="form.weekdaysOnly" type="checkbox" /> Weekdays only</label
          >
          <template v-if="form.freq === 'monthly'">
            <select v-model="form.monthly" class="input w-auto" aria-label="Day of the month">
              <option value="day">On day</option>
              <option value="last_day">On the last day</option>
              <option value="last_weekday">On the last weekday</option>
            </select>
            <input v-if="form.monthly === 'day'" v-model="form.day" type="number" min="1" max="31" class="input w-20" aria-label="Day" />
          </template>
          <template v-if="form.freq === 'yearly'">
            <span class="text-sm">on</span>
            <input v-model="form.day" type="number" min="1" max="31" class="input w-20" aria-label="Day" />
            <select v-model="form.month" class="input w-auto" aria-label="Month">
              <option v-for="(m, i) in MONTHS" :key="m" :value="i + 1">{{ m }}</option>
            </select>
          </template>
        </div>
        <div v-if="form.freq === 'weekly'" class="flex flex-wrap gap-1" role="group" aria-label="Days of the week">
          <button
            v-for="d in DAYS"
            :key="d[0]"
            type="button"
            class="rounded-full border px-3 py-1 text-xs"
            :class="form.weekdays.includes(d[0]) ? 'border-blue-600 bg-blue-50 text-blue-900' : 'border-slate-300 bg-white text-slate-700'"
            :aria-pressed="form.weekdays.includes(d[0])"
            @click="toggleDay(d[0])"
          >
            {{ d[1] }}
          </button>
        </div>
        <div class="flex flex-wrap items-center gap-2 text-sm">
          <label for="rr-start">Starts</label><input id="rr-start" v-model="form.startDate" type="date" class="input w-auto" required />
          <label for="rr-ends">Ends</label>
          <select id="rr-ends" v-model="form.ends" class="input w-auto">
            <option value="never">Never</option>
            <option value="date">On a date</option>
            <option value="count">After a number of issues</option>
          </select>
          <input v-if="form.ends === 'date'" v-model="form.endDate" type="date" class="input w-auto" aria-label="End date" required />
          <input
            v-if="form.ends === 'count'"
            v-model="form.maxCount"
            type="number"
            min="1"
            max="10000"
            class="input w-24"
            aria-label="Number of issues"
            required
          />
        </div>
        <p class="text-sm font-medium" :class="preview?.error ? 'text-red-700' : 'text-slate-800'" aria-live="polite">{{ previewLine }}</p>
        <p v-if="preview?.dates?.length > 1" class="text-xs text-slate-500">Then {{ preview.dates.slice(1).map(fmtDate).join(', ') }}</p>
        <label class="flex items-center gap-1 text-sm"><input v-model="form.paused" type="checkbox" /> Paused</label>
      </fieldset>
      <div class="flex gap-2 sm:col-span-2">
        <button class="btn btn-primary" :disabled="busy">Save rule</button
        ><button type="button" class="btn" @click="editing = null">Cancel</button>
      </div>
    </form>
  </div>
</template>
