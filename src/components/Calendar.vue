<script setup>
// Issues by due date: month view (default) and week view (start to due spans as bars), an agenda list on small
// screens. API: GET /api/calendar (server/routes/calendar.js). Drag an issue to another day to move its due date
// (a span moves as a whole); + on a day creates an issue due that day; a click opens the issue drawer.
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { get, post, del, qs, session } from '../api.js';
import { copyText } from '../browser.js';
import { ui, openCreate, openIssue } from '../ui.js';
import { TYPES, categoryCls } from '../meta.js';
import { localIso as iso, today as localToday } from '../dates.js';
import { parse, addDays, monday, place, droppedOn } from '../calendar.js';
import { patchOptimistic } from '../issues.js';
import { projectList } from '../projects.js';
import TypeIcon from './TypeIcon.vue';
import UserSelect from './UserSelect.vue';
import Modal from './Modal.vue';
import Icon from './Icon.vue';
import { attempt } from '../composables/useAction.js';

const props = defineProps({ projectKey: String, project: Object });

// ---- dates (local, YYYY-MM-DD; the grid works on Date objects: src/calendar.js) ----
const today = localToday();
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

let saved = {};
try {
  saved = JSON.parse(localStorage.getItem('it_calendar') || '{}');
} catch {
  /* storage blocked */
}
const view = ref(saved.view === 'week' ? 'week' : 'month');
const cursor = ref(new Date());
const f = reactive({ project: '', assignee: saved.assignee || '', person: null, type: '', includeDone: Boolean(saved.includeDone) });
watch(
  () => [view.value, f.assignee, f.includeDone],
  () => {
    try {
      localStorage.setItem(
        'it_calendar',
        JSON.stringify({ view: view.value, assignee: f.assignee === 'person' ? '' : f.assignee, includeDone: f.includeDone }),
      );
    } catch {
      /* storage blocked */
    }
  },
);

const small = ref(false);
let mq = null;
const onMq = () => {
  small.value = Boolean(mq?.matches);
};
onMounted(() => {
  mq = window.matchMedia?.('(max-width: 639px)') || null;
  onMq();
  mq?.addEventListener?.('change', onMq);
});
onBeforeUnmount(() => mq?.removeEventListener?.('change', onMq));

const range = computed(() => {
  if (view.value === 'week') {
    const start = monday(cursor.value);
    return { from: iso(start), to: iso(addDays(start, 6)), start };
  }
  const first = new Date(cursor.value.getFullYear(), cursor.value.getMonth(), 1);
  const start = monday(first);
  return { from: iso(start), to: iso(addDays(start, 41)), start };
});
const title = computed(() => {
  if (view.value === 'month') return cursor.value.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const s = parse(range.value.from);
  const e = parse(range.value.to);
  return `${s.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} to ${e.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
});
function step(dir) {
  const c = cursor.value;
  cursor.value = view.value === 'week' ? addDays(c, dir * 7) : new Date(c.getFullYear(), c.getMonth() + dir, 1);
}

// ---- data ----
const issues = ref([]);
const sprints = ref([]);
const truncated = ref(false);
const loading = ref(true);
const error = ref('');
const projects = ref([]);
const projectFilter = computed(() => props.projectKey || f.project);
async function load() {
  const assignee = f.assignee === 'person' ? f.person : f.assignee;
  if (f.assignee === 'person' && !f.person) return;
  try {
    const r = await get(
      `/api/calendar?${qs({ from: range.value.from, to: range.value.to, project: projectFilter.value, assignee, type: f.type, includeDone: f.includeDone ? '1' : '' })}`,
    );
    issues.value = r.issues;
    sprints.value = r.sprints;
    truncated.value = r.truncated;
    error.value = '';
  } catch (e) {
    error.value = e.message;
  }
  loading.value = false;
}
watch(() => [range.value.from, range.value.to, f.project, f.assignee, f.person, f.type, f.includeDone, ui.changes], load, {
  immediate: true,
});
onMounted(async () => {
  if (!props.projectKey) {
    try {
      projects.value = await projectList();
    } catch {
      /* filter still works without names */
    }
  }
});

// ---- layout ----
const isSpan = (i) => view.value === 'week' && i.startDate && i.dueDate && i.startDate < i.dueDate;
const dayOf = (i) => i.dueDate || i.startDate;
const byDay = computed(() => {
  const m = new Map();
  for (const i of issues.value) {
    if (isSpan(i)) continue;
    const d = dayOf(i);
    if (!m.has(d)) m.set(d, []);
    m.get(d).push(i);
  }
  return m;
});
const month = computed(() => cursor.value.getMonth());
const weeks = computed(() => {
  const n = view.value === 'week' ? 1 : 6;
  return Array.from({ length: n }, (_, w) => {
    const days = Array.from({ length: 7 }, (_, d) => {
      const date = addDays(range.value.start, w * 7 + d);
      return { date: iso(date), num: date.getDate(), inMonth: view.value === 'week' || date.getMonth() === month.value };
    });
    return { days, from: days[0].date, to: days[6].date };
  });
});
// bars (sprints in month view, issue spans in week view) clipped to a week: place() gives grid-column start / end
const showSprints = computed(() => view.value === 'month' && Boolean(projectFilter.value));
const sprintBars = (week) =>
  showSprints.value ? sprints.value.map((s) => ({ s, style: place(week, s.startDate, s.endDate) })).filter((x) => x.style) : [];
const spanBars = (week) =>
  issues.value
    .filter(isSpan)
    .map((i) => ({ i, style: place(week, i.startDate, i.dueDate) }))
    .filter((x) => x.style);
const expanded = reactive(new Set());
const MAX_IN_CELL = 3;
const cellIssues = (day) => {
  const list = byDay.value.get(day) || [];
  return view.value === 'month' && !expanded.has(day) ? list.slice(0, MAX_IN_CELL) : list;
};
const more = (day) => (byDay.value.get(day) || []).length - MAX_IN_CELL;
const agendaDays = computed(() => weeks.value.flatMap((w) => w.days).filter((d) => d.inMonth));
const agendaIssues = (day) => issues.value.filter((i) => dayOf(i) === day);
const dayLabel = (day, opts = { weekday: 'short', day: 'numeric', month: 'short' }) => parse(day).toLocaleDateString(undefined, opts);

const overdue = (i) => Boolean(i.dueDate) && i.dueDate < today && i.status.category !== 'done';
const issueLabel = (i) =>
  `${i.key} ${i.title}, ${i.status.name}${overdue(i) ? ', overdue' : ''}${i.startDate && i.dueDate && i.startDate < i.dueDate ? `, ${dayLabel(i.startDate)} to ${dayLabel(i.dueDate)}` : ''}`;
const canCreate = computed(() => (props.project ? props.project.canCreate : session.user?.role !== 'viewer'));
const createOn = (day) =>
  openCreate({ ...(projectFilter.value && !projectFilter.value.includes(',') ? { projectKey: projectFilter.value } : {}), dueDate: day });

// ---- open, drag to another day ----
const drag = reactive({ id: null, over: null });
function onDragStart(e, i) {
  drag.id = i.id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', i.key);
}
const endDrag = () => Object.assign(drag, { id: null, over: null });
async function onDrop(day) {
  const i = issues.value.find((x) => x.id === drag.id);
  endDrag();
  if (!i || dayOf(i) === day) return;
  // a start to due span moves as a whole; an issue with only a start date gets the day as due date
  await patchOptimistic(i, droppedOn(i, day), `${i.key} is now due ${dayLabel(day)}`);
}

// ---- calendar subscription (.ics) ----
const sub = reactive({ open: false, enabled: true, feeds: [], url: '', name: '', busy: false });
async function openSub() {
  Object.assign(sub, { open: true, url: '', name: props.projectKey ? `${props.projectKey} calendar` : 'My calendar' });
  await attempt(async () => {
    const r = await get('/api/calendar/feeds');
    sub.enabled = r.enabled;
    sub.feeds = r.feeds;
  });
}
async function createSub() {
  sub.busy = true;
  await attempt(async () => {
    const assignee = f.assignee === 'person' ? f.person : f.assignee;
    const r = await post('/api/calendar/feeds', {
      name: sub.name,
      query: {
        project: projectFilter.value || undefined,
        assignee: assignee || undefined,
        type: f.type || undefined,
        includeDone: f.includeDone ? '1' : undefined,
      },
    });
    sub.url = r.url;
    sub.feeds = (await get('/api/calendar/feeds')).feeds;
  });
  sub.busy = false;
}
async function revokeSub(feed) {
  if (!confirm(`Stop the subscription "${feed.name}"? Calendars that use its link stop updating.`)) return;
  await attempt(async () => {
    await del(`/api/feeds/${feed.id}`);
    sub.feeds = sub.feeds.filter((x) => x.id !== feed.id);
  });
}
const copy = (text) => copyText(text, { ok: 'Link copied', fail: 'Could not copy. Copy the link from the box.' });
</script>

<template>
  <div>
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <div class="flex items-center gap-1">
        <button class="btn btn-sm" :aria-label="view === 'week' ? 'Previous week' : 'Previous month'" @click="step(-1)">
          <Icon name="collapse" :size="14" />
        </button>
        <button class="btn btn-sm" @click="cursor = new Date()">Today</button>
        <button class="btn btn-sm" :aria-label="view === 'week' ? 'Next week' : 'Next month'" @click="step(1)">
          <Icon name="expand" :size="14" />
        </button>
      </div>
      <h2 class="min-w-[9rem] text-base font-semibold" aria-live="polite">{{ title }}</h2>
      <div class="flex rounded-full border border-slate-300 p-0.5" role="group" aria-label="View">
        <button
          class="rounded-full px-3 py-0.5 text-sm"
          :class="view === 'month' ? 'bg-black text-white' : 'text-slate-700'"
          :aria-pressed="view === 'month'"
          @click="view = 'month'"
        >
          Month
        </button>
        <button
          class="rounded-full px-3 py-0.5 text-sm"
          :class="view === 'week' ? 'bg-black text-white' : 'text-slate-700'"
          :aria-pressed="view === 'week'"
          @click="view = 'week'"
        >
          Week
        </button>
      </div>
      <select v-if="!projectKey" v-model="f.project" class="input w-auto py-1" aria-label="Project">
        <option value="">All projects</option>
        <option v-for="p in projects" :key="p.id" :value="p.key">{{ p.key }} {{ p.name }}</option>
      </select>
      <select v-model="f.assignee" class="input w-auto py-1" aria-label="Assignee">
        <option value="">Anyone</option>
        <option value="me">Assigned to me</option>
        <option value="unassigned">Unassigned</option>
        <option value="person">A person</option>
      </select>
      <div v-if="f.assignee === 'person'" class="w-48">
        <UserSelect v-model="f.person" :allow-none="false" placeholder="Choose a person" compact />
      </div>
      <select v-model="f.type" class="input w-auto py-1" aria-label="Type">
        <option value="">All types</option>
        <option v-for="t in TYPES" :key="t.id" :value="t.id">{{ t.label }}</option>
      </select>
      <label class="flex items-center gap-1 text-sm text-slate-700"><input v-model="f.includeDone" type="checkbox" /> Include done</label>
      <button class="btn btn-sm ml-auto" @click="openSub"><Icon name="calendar" :size="14" />Subscribe</button>
    </div>
    <div class="mb-2 flex flex-wrap items-center gap-3 text-xs text-slate-600">
      <span class="chip bg-slate-200 text-slate-700">To do</span><span class="chip bg-blue-100 text-blue-800">In progress</span
      ><span class="chip bg-green-100 text-green-800">Done</span>
      <span class="chip bg-white text-red-800 ring-2 ring-red-600">Overdue</span>
      <span v-if="showSprints" class="chip bg-violet-100 text-violet-900">Sprint</span>
      <span class="hidden sm:inline">Drag an issue to another day to change its due date.</span>
    </div>
    <p v-if="error" class="mb-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">{{ error }}</p>
    <p v-if="truncated" class="mb-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
      Only the first 1,000 issues are shown. Use the filters to narrow the calendar.
    </p>

    <!-- agenda: small screens -->
    <div v-if="small" class="space-y-3">
      <p v-if="!loading && !agendaDays.some((d) => agendaIssues(d.date).length)" class="text-sm text-slate-600">
        Nothing due in this {{ view === 'week' ? 'week' : 'month' }}.
      </p>
      <section v-for="d in agendaDays.filter((x) => agendaIssues(x.date).length || x.date === today)" :key="d.date">
        <div class="mb-1 flex items-center gap-2">
          <h3 class="text-sm font-semibold" :class="d.date === today ? 'text-link' : ''">
            {{ dayLabel(d.date, { weekday: 'long', day: 'numeric', month: 'long' }) }}<span v-if="d.date === today"> (today)</span>
          </h3>
          <button
            v-if="canCreate"
            class="btn btn-ghost btn-sm ml-auto"
            :aria-label="`Create an issue due ${dayLabel(d.date)}`"
            @click="createOn(d.date)"
          >
            <Icon name="plus" :size="14" />
          </button>
        </div>
        <ul class="space-y-1">
          <li v-for="i in agendaIssues(d.date)" :key="i.id">
            <button
              class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
              :class="[categoryCls(i.status.category), overdue(i) ? 'ring-2 ring-red-600' : '']"
              :aria-label="issueLabel(i)"
              @click="openIssue(i.key)"
            >
              <TypeIcon :type="i.type" :size="14" /><span class="font-semibold">{{ i.key }}</span
              ><span class="min-w-0 flex-1 truncate">{{ i.title }}</span
              ><span v-if="overdue(i)" class="font-bold text-red-800" aria-hidden="true">!</span>
            </button>
          </li>
        </ul>
      </section>
    </div>

    <!-- month / week grid -->
    <div v-else class="overflow-hidden rounded-[15px] border border-slate-200">
      <div class="grid grid-cols-7 border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
        <div v-for="(w, n) in WEEKDAYS" :key="w" class="px-2 py-1.5">
          {{ w }}<span v-if="view === 'week'" class="font-normal"> {{ weeks[0].days[n].num }}</span>
        </div>
      </div>
      <div v-for="week in weeks" :key="week.from" class="border-b border-slate-200 last:border-b-0">
        <div v-for="b in sprintBars(week)" :key="b.s.id" class="grid grid-cols-7 px-0.5 pt-0.5">
          <div
            class="truncate rounded bg-violet-100 px-2 text-[11px] font-medium leading-5 text-violet-900"
            :style="b.style"
            :title="`${b.s.name}: ${b.s.startDate} to ${b.s.endDate}`"
          >
            {{ b.s.name }}
          </div>
        </div>
        <div v-for="b in spanBars(week)" :key="b.i.id" class="grid grid-cols-7 px-0.5 pt-0.5">
          <div
            role="button"
            tabindex="0"
            class="flex cursor-pointer items-center gap-1 truncate rounded px-2 py-0.5 text-xs"
            :class="[categoryCls(b.i.status.category), overdue(b.i) ? 'ring-2 ring-red-600' : '', drag.id === b.i.id ? 'opacity-40' : '']"
            :style="b.style"
            :draggable="b.i.canEdit"
            :aria-label="issueLabel(b.i)"
            @dragstart="onDragStart($event, b.i)"
            @dragend="endDrag"
            @click="openIssue(b.i.key)"
            @keydown.enter.prevent="openIssue(b.i.key)"
            @keydown.space.prevent="openIssue(b.i.key)"
          >
            <TypeIcon :type="b.i.type" :size="12" /><span class="font-semibold">{{ b.i.key }}</span
            ><span class="truncate">{{ b.i.title }}</span>
          </div>
        </div>
        <div class="grid grid-cols-7">
          <div
            v-for="d in week.days"
            :key="d.date"
            class="group min-w-0 border-r border-slate-100 p-1 last:border-r-0"
            :class="[
              view === 'week' ? 'min-h-48' : 'min-h-24',
              d.inMonth ? '' : 'bg-slate-50',
              drag.id && drag.over === d.date ? 'bg-blue-50 ring-2 ring-inset ring-blue-300' : '',
            ]"
            @dragover.prevent="drag.over = d.date"
            @drop.prevent="onDrop(d.date)"
          >
            <div class="mb-0.5 flex items-center">
              <span
                v-if="view === 'month'"
                class="flex h-6 min-w-[1.5rem] items-center justify-center rounded-full px-1 text-xs"
                :class="d.date === today ? 'bg-black font-semibold text-white' : d.inMonth ? 'text-slate-700' : 'text-slate-500'"
                >{{ d.num }}</span
              >
              <span v-else-if="d.date === today" class="chip bg-black text-white">Today</span>
              <button
                v-if="canCreate"
                class="ml-auto rounded px-1 text-sm leading-none text-slate-500 opacity-100 hover:bg-slate-200 hover:text-slate-900 focus:opacity-100 lg:opacity-0 lg:group-hover:opacity-100"
                :aria-label="`Create an issue due ${dayLabel(d.date)}`"
                @click="createOn(d.date)"
              >
                +
              </button>
            </div>
            <div
              v-for="i in cellIssues(d.date)"
              :key="i.id"
              role="button"
              tabindex="0"
              class="mb-0.5 flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-xs"
              :class="[
                categoryCls(i.status.category),
                overdue(i) ? 'ring-2 ring-inset ring-red-600' : '',
                drag.id === i.id ? 'opacity-40' : '',
              ]"
              :draggable="i.canEdit"
              :aria-label="issueLabel(i)"
              :title="issueLabel(i)"
              @dragstart="onDragStart($event, i)"
              @dragend="endDrag"
              @click="openIssue(i.key)"
              @keydown.enter.prevent="openIssue(i.key)"
              @keydown.space.prevent="openIssue(i.key)"
            >
              <TypeIcon :type="i.type" :size="12" aria-hidden="true" /><span class="shrink-0 font-semibold">{{ i.key }}</span
              ><span class="min-w-0 truncate">{{ i.title }}</span
              ><span v-if="overdue(i)" class="ml-auto font-bold text-red-800" aria-hidden="true">!</span>
            </div>
            <button
              v-if="view === 'month' && more(d.date) > 0"
              class="px-1 text-xs text-slate-700 underline"
              @click="expanded.has(d.date) ? expanded.delete(d.date) : expanded.add(d.date)"
            >
              {{ expanded.has(d.date) ? 'Show less' : `${more(d.date)} more` }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <Modal v-if="sub.open" title="Subscribe to this calendar" @close="sub.open = false">
      <div class="space-y-3 text-sm">
        <p v-if="!sub.enabled" class="rounded-md bg-amber-50 px-3 py-2 text-amber-900">Feeds are turned off by an admin.</p>
        <template v-else>
          <p class="text-slate-600">
            Get a secret link to add these issues to Google Calendar, Outlook or Apple Calendar (as "From URL" or "Subscribe"). It uses the
            filters shown now and your current access. Anyone with the link can see the issues in it, so keep it private.
          </p>
          <form v-if="!sub.url" class="flex flex-wrap items-end gap-2" @submit.prevent="createSub">
            <div class="min-w-0 flex-1">
              <label class="label" for="cal-sub-name">Name</label
              ><input id="cal-sub-name" v-model="sub.name" class="input" maxlength="100" />
            </div>
            <button class="btn btn-primary" :disabled="sub.busy">Create link</button>
          </form>
          <div v-else class="space-y-1">
            <label class="label" for="cal-sub-url">Your link (shown once)</label>
            <div class="flex gap-2">
              <input id="cal-sub-url" :value="sub.url" class="input" readonly @focus="$event.target.select()" /><button
                class="btn"
                @click="copy(sub.url)"
              >
                Copy
              </button>
            </div>
          </div>
          <div v-if="sub.feeds.length">
            <h3 class="label">Your calendar links</h3>
            <ul class="divide-y divide-slate-100">
              <li v-for="x in sub.feeds" :key="x.id" class="flex items-center gap-2 py-1.5">
                <span class="min-w-0 flex-1 truncate"
                  >{{ x.name }} <span class="text-xs text-slate-500">{{ x.prefix }}...</span></span
                >
                <button class="btn btn-sm btn-danger" :aria-label="`Stop ${x.name}`" @click="revokeSub(x)">Stop</button>
              </li>
            </ul>
          </div>
        </template>
      </div>
    </Modal>
  </div>
</template>
