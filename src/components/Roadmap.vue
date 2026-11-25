<script setup>
// Roadmap: epics as bars from start date to due date, with their child issues, progress and 'blocks' links.
// projectKey: one project (Project > Roadmap); empty: every project the viewer can see (/roadmap, with a picker).
// Drag a bar to move it, drag an end to change one date, click (or Enter) to open the issue. Saves through
// PATCH /api/issues/:key, shown at once and put back when the server refuses.
import { ref, reactive, computed, watch, nextTick } from 'vue';
import { get, toast, qs } from '../api.js';
import { ui, openIssue } from '../ui.js';
import { CATEGORIES, fmtDate } from '../meta.js';
import { today as localToday } from '../dates.js';
import { patchOptimistic } from '../issues.js';
import { projectList } from '../projects.js';
import { dayOf, isoOf, ZOOMS, span, timelineRange, timelineTicks, draggedDates } from '../roadmap.js';
import TypeIcon from './TypeIcon.vue';
import Avatar from './Avatar.vue';
import Skeleton from './Skeleton.vue';
import { plural } from '../plural.js';

const props = defineProps({ projectKey: { type: String, default: '' } });

const data = ref(null);
const loading = ref(true);
const error = ref('');
const allProjects = ref([]);
const f = reactive({ project: '', orphans: false, assignee: '', label: '', category: '', text: '', zoom: 'months' });
const expanded = reactive(new Set());

const projectParam = computed(() => props.projectKey || f.project);
async function load() {
  try {
    data.value = await get(`/api/roadmap?${qs({ project: projectParam.value, includeOrphans: f.orphans ? '1' : '' })}`);
    error.value = '';
  } catch (e) {
    error.value = e.message;
  }
  loading.value = false;
}
watch(() => [projectParam.value, f.orphans, ui.changes], load, { immediate: true });
if (!props.projectKey)
  projectList()
    .then((list) => {
      allProjects.value = list;
    })
    .catch(() => {});

// ---- dates (whole days, UTC: src/roadmap.js) ----
const todayIso = localToday();
const today = dayOf(todayIso);
const ppd = computed(() => ZOOMS[f.zoom].ppd);

// ---- filters ----
const allIssues = computed(() => (data.value ? [...data.value.epics.flatMap((e) => [e, ...e.children]), ...data.value.orphans] : []));
const people = computed(() => {
  const m = new Map();
  for (const i of allIssues.value) if (i.assignee) m.set(i.assignee.id, i.assignee);
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
});
const labels = computed(() => [...new Set(allIssues.value.flatMap((i) => i.labels))].sort());
const filtering = computed(() => Boolean(f.assignee || f.label || f.category));
const matches = (i) =>
  (!f.assignee || (f.assignee === 'none' ? !i.assignee : i.assignee?.id === f.assignee)) &&
  (!f.label || i.labels.includes(f.label)) &&
  (!f.category || i.status.category === f.category);
const textOk = (i) => {
  const t = f.text.trim().toLowerCase();
  return !t || i.title.toLowerCase().includes(t) || i.key.toLowerCase().includes(t);
};
const epics = computed(() =>
  (data.value?.epics || [])
    .filter((e) => textOk(e) && (matches(e) || e.children.some(matches)))
    .map((e) => ({ ...e, shown: filtering.value ? e.children.filter(matches) : e.children })),
);
const dated = computed(() => epics.value.filter((e) => span(e)));
const undated = computed(() => epics.value.filter((e) => !span(e)));
const orphans = computed(() => (data.value?.orphans || []).filter((i) => textOk(i) && matches(i)));
const canEdit = (i) => Boolean(data.value?.projects.find((p) => p.key === i.projectKey)?.canEdit);

// ---- rows (fixed heights so links can be drawn across rows) ----
const H = { epic: 44, child: 30, section: 30 };
const rows = computed(() => {
  const out = [];
  for (const e of dated.value) {
    out.push({ kind: 'epic', issue: e, h: H.epic });
    if (expanded.has(e.key)) for (const c of e.shown) out.push({ kind: 'child', issue: c, h: H.child });
  }
  if (f.orphans && orphans.value.length) {
    out.push({ kind: 'section', label: 'Issues without an epic', h: H.section });
    for (const o of orphans.value) out.push({ kind: 'child', issue: o, h: H.child });
  }
  let y = 0;
  for (const r of out) {
    r.y = y;
    y += r.h;
  }
  return out;
});
const bodyHeight = computed(() => rows.value.reduce((s, r) => s + r.h, 0));

// ---- timeline range and ticks ----
const range = computed(() => timelineRange(allIssues.value, today, f.zoom));
const width = computed(() => (range.value.end - range.value.start) * ppd.value);
const xOf = (day) => (day - range.value.start) * ppd.value;
const ticks = computed(() => timelineTicks(range.value, f.zoom, ppd.value));

// ---- bars (with the drag preview) ----
const drag = reactive({ key: null, mode: null, x0: 0, delta: 0, moved: false, orig: null });
function barOf(i) {
  let s = span(i);
  if (!s) return null;
  if (drag.key === i.key && drag.moved) {
    s = { ...s };
    if (drag.mode === 'move') {
      s.start += drag.delta;
      s.end += drag.delta;
    }
    if (drag.mode === 'start') s.start = Math.min(s.start + drag.delta, s.end);
    if (drag.mode === 'end') s.end = Math.max(s.end + drag.delta, s.start);
  }
  return { ...s, x: xOf(s.start), w: Math.max((s.end - s.start + 1) * ppd.value, s.point ? 0 : 6) };
}
function onPointerDown(e, issue, mode) {
  if (e.button !== 0) return;
  e.stopPropagation();
  drag.key = issue.key;
  drag.mode = canEdit(issue) ? mode : 'click';
  drag.x0 = e.clientX;
  drag.delta = 0;
  drag.moved = false;
  drag.orig = issue;
  e.currentTarget.setPointerCapture?.(e.pointerId);
}
// Draw dates on an empty row: press on the timeline, drag to the last day, release.
const draw = reactive({ key: null, issue: null, anchor: 0, current: 0, left: 0 });
const dayAt = (clientX) => range.value.start + Math.floor((clientX - draw.left) / ppd.value);
function onTrackDown(e, issue) {
  if (e.button !== 0 || !canEdit(issue) || barOf(issue)) return;
  draw.left = e.currentTarget.getBoundingClientRect().left;
  draw.key = issue.key;
  draw.issue = issue;
  draw.anchor = draw.current = dayAt(e.clientX);
  e.currentTarget.setPointerCapture?.(e.pointerId);
  e.preventDefault();
}
const drawBar = (issue) => {
  if (draw.key !== issue.key) return null;
  const a = Math.min(draw.anchor, draw.current);
  const b = Math.max(draw.anchor, draw.current);
  return { x: xOf(a), w: (b - a + 1) * ppd.value, a, b };
};
async function finishDraw() {
  const { issue, anchor, current } = draw;
  Object.assign(draw, { key: null, issue: null });
  const a = Math.min(anchor, current);
  const b = Math.max(anchor, current);
  await saveDates(issue, { startDate: isoOf(a), dueDate: isoOf(b) });
}
function onPointerMove(e) {
  if (draw.key) {
    draw.current = dayAt(e.clientX);
    return;
  }
  if (!drag.key || drag.mode === 'click') return;
  const dx = e.clientX - drag.x0;
  if (Math.abs(dx) > 3) drag.moved = true;
  drag.delta = Math.round(dx / ppd.value);
}
async function onPointerUp() {
  if (draw.key) return finishDraw();
  if (!drag.key) return;
  const issue = drag.orig;
  const { mode, moved, delta } = drag;
  Object.assign(drag, { key: null, mode: null, delta: 0, moved: false, orig: null });
  if (!moved || mode === 'click') return openIssue(issue.key);
  if (!delta) return;
  await saveDates(issue, draggedDates(issue, mode, delta));
}
const saveDates = (issue, next) =>
  patchOptimistic(
    findIssue(issue.key) || issue,
    next,
    `${issue.key}: ${fmtDate(next.startDate) || 'no start'} to ${fmtDate(next.dueDate) || 'no due date'}`,
  );
function findIssue(key) {
  for (const e of data.value?.epics || []) {
    if (e.key === key) return e;
    const c = e.children.find((x) => x.key === key);
    if (c) return c;
  }
  return data.value?.orphans.find((x) => x.key === key) || null;
}

// ---- dependencies ----
const rowByKey = computed(() => new Map(rows.value.filter((r) => r.issue).map((r) => [r.issue.key, r])));
const deps = computed(() => {
  const out = [];
  for (const l of data.value?.links || []) {
    const a = rowByKey.value.get(l.from);
    const b = rowByKey.value.get(l.to);
    if (!a || !b) continue;
    const ba = barOf(a.issue);
    const bb = barOf(b.issue);
    if (!ba || !bb) continue;
    const x1 = ba.point ? ba.x + ppd.value / 2 + 6 : ba.x + ba.w;
    const y1 = a.y + a.h / 2;
    const x2 = bb.point ? bb.x + ppd.value / 2 - 6 : bb.x;
    const y2 = b.y + b.h / 2;
    const bend = Math.max(16, Math.min(60, Math.abs(x2 - x1) / 2));
    out.push({
      key: `${l.from}>${l.to}`,
      from: l.from,
      to: l.to,
      late: bb.start <= ba.end,
      d: `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2 - 4},${y2}`,
    });
  }
  return out;
});
const lateBy = computed(() => {
  const m = new Map();
  for (const d of deps.value) if (d.late) m.set(d.to, [...(m.get(d.to) || []), d.from]);
  return m;
});

// ---- set dates for epics without any ----
const setting = reactive({ key: null, start: '', due: '' });
function startSetDates(e) {
  const s = e.summary.suggestedStart || todayIso;
  const d = e.summary.suggestedDue && e.summary.suggestedDue >= s ? e.summary.suggestedDue : isoOf(dayOf(s) + 30);
  Object.assign(setting, { key: e.key, start: s, due: d });
}
async function saveSetDates(e) {
  if (setting.start && setting.due && setting.start > setting.due)
    return toast('The start date must be on or before the due date', 'error');
  const issue = findIssue(e.key);
  setting.key = null;
  await saveDates(issue, { startDate: setting.start || null, dueDate: setting.due || null });
}

const progressText = (e) =>
  e.summary.byPoints ? `${e.summary.pointsDone} of ${e.summary.points} points done` : `${e.summary.done} of ${e.summary.total} issues done`;
const barTitle = (i) =>
  `${i.key} ${i.title}\n${fmtDate(i.startDate) || 'No start date'} to ${fmtDate(i.dueDate) || 'no due date'}${i.summary ? `\n${progressText(i)}` : ''}`;
function toggle(key) {
  if (expanded.has(key)) expanded.delete(key);
  else expanded.add(key);
}
const allOpen = computed(() => dated.value.length && dated.value.every((e) => expanded.has(e.key)));
function toggleAll() {
  if (allOpen.value) expanded.clear();
  else for (const e of dated.value) expanded.add(e.key);
}

// ---- drawer and scroll ----
const scroller = ref(null);
function scrollToToday() {
  const el = scroller.value;
  if (el) el.scrollLeft = Math.max(0, xOf(today) - el.clientWidth / 3);
}
let scrolled = false;
watch([() => data.value, () => f.zoom], async (now, before) => {
  if (!data.value) return;
  if (scrolled && before?.[1] === f.zoom) return; // reloads keep the scroll; a new zoom goes back to today
  scrolled = true;
  await nextTick();
  scrollToToday();
});
const statusDot = { todo: 'bg-slate-400', in_progress: 'bg-blue-500', done: 'bg-positive' };
</script>

<template>
  <div>
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <select v-if="!projectKey" v-model="f.project" class="input w-auto py-1" aria-label="Project">
        <option value="">All projects</option>
        <option v-for="p in allProjects" :key="p.id" :value="p.key">{{ p.key }} {{ p.name }}</option>
      </select>
      <input v-model="f.text" class="input w-44 py-1" placeholder="Find an epic" aria-label="Find an epic" />
      <select v-model="f.assignee" class="input w-auto py-1" aria-label="Assignee">
        <option value="">Anyone</option>
        <option value="none">Unassigned</option>
        <option v-for="p in people" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
      <select v-if="labels.length" v-model="f.label" class="input w-auto py-1" aria-label="Label">
        <option value="">All labels</option>
        <option v-for="l in labels" :key="l" :value="l">{{ l }}</option>
      </select>
      <select v-model="f.category" class="input w-auto py-1" aria-label="Status">
        <option value="">Any status</option>
        <option v-for="c in CATEGORIES" :key="c.id" :value="c.id">{{ c.label }}</option>
      </select>
      <label class="flex items-center gap-1 text-sm text-slate-600"
        ><input v-model="f.orphans" type="checkbox" /> Issues without an epic</label
      >
      <div class="ml-auto flex items-center gap-1">
        <button class="btn btn-sm" @click="toggleAll">{{ allOpen ? 'Collapse all' : 'Expand all' }}</button>
        <button class="btn btn-sm" @click="scrollToToday">Today</button>
        <div class="flex rounded-full border border-slate-300 p-0.5" role="group" aria-label="Zoom">
          <button
            v-for="(z, id) in ZOOMS"
            :key="id"
            class="rounded-full px-2.5 py-0.5 text-xs font-semibold"
            :class="f.zoom === id ? 'bg-black text-white' : 'text-slate-600 hover:bg-slate-100'"
            :aria-pressed="f.zoom === id"
            @click="f.zoom = id"
          >
            {{ z.label }}
          </button>
        </div>
      </div>
    </div>

    <p v-if="error" class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">{{ error }}</p>
    <div v-else-if="loading" class="card p-3"><Skeleton :rows="5" /></div>
    <template v-else-if="data">
      <p v-if="data.truncated" class="mb-2 rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-900">
        Showing the first 3,000 issues. Pick a project to see the rest.
      </p>
      <p v-if="!data.epics.length && !data.orphans.length" class="card px-4 py-8 text-center text-sm text-slate-600">
        No epics yet. Create an epic and give it a start and due date to see it here.
      </p>

      <div
        v-if="rows.length"
        ref="scroller"
        class="card relative overflow-x-auto [--rm-left:9.5rem] sm:[--rm-left:19rem]"
        :class="drag.key && drag.moved ? 'cursor-grabbing select-none' : ''"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
      >
        <div class="relative" :style="{ width: `calc(var(--rm-left) + ${width}px)` }">
          <!-- header -->
          <div class="sticky top-0 z-30 flex h-8 border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
            <div
              class="sticky left-0 z-30 flex w-[var(--rm-left)] shrink-0 items-center border-r border-slate-200 bg-slate-50 px-3 font-semibold"
            >
              {{ dated.length }} {{ plural(dated.length, 'epic') }}
            </div>
            <div class="relative" :style="{ width: width + 'px' }">
              <div
                v-for="t in ticks"
                :key="t.day"
                class="absolute top-0 flex h-full items-center border-l border-slate-200 px-1.5 whitespace-nowrap"
                :style="{ left: t.x + 'px', width: t.w + 'px' }"
              >
                {{ t.label }}
              </div>
            </div>
          </div>

          <!-- grid lines, today, dependency links (drawn under the sticky column) -->
          <svg
            class="pointer-events-none absolute z-10"
            :style="{ left: 'var(--rm-left)', top: '2rem' }"
            :width="width"
            :height="bodyHeight"
            aria-hidden="true"
          >
            <defs>
              <marker id="rm-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" fill="#78716c" />
              </marker>
              <marker id="rm-arrow-late" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" fill="#b91c1c" />
              </marker>
            </defs>
            <line v-for="t in ticks" :key="t.day" :x1="t.x" :x2="t.x" y1="0" :y2="bodyHeight" stroke="#f3f4f8" />
            <path
              v-for="d in deps"
              :key="d.key"
              :d="d.d"
              fill="none"
              :stroke="d.late ? '#b91c1c' : '#78716c'"
              stroke-width="1.25"
              :stroke-dasharray="d.late ? '4 3' : null"
              :marker-end="d.late ? 'url(#rm-arrow-late)' : 'url(#rm-arrow)'"
            />
            <line :x1="xOf(today)" :x2="xOf(today)" y1="0" :y2="bodyHeight" stroke="#4f46e5" stroke-width="2" />
          </svg>

          <!-- rows -->
          <div
            v-for="r in rows"
            :key="r.kind + (r.issue?.key || r.label)"
            class="flex border-b border-slate-100"
            :style="{ height: r.h + 'px' }"
          >
            <template v-if="r.kind === 'section'">
              <div
                class="sticky left-0 z-20 flex w-[var(--rm-left)] shrink-0 items-center border-r border-slate-200 bg-slate-50 px-3 text-xs font-semibold uppercase text-slate-500"
              >
                {{ r.label }}
              </div>
              <div class="bg-slate-50" :style="{ width: width + 'px' }"></div>
            </template>
            <template v-else>
              <div
                class="sticky left-0 z-20 flex w-[var(--rm-left)] shrink-0 items-center gap-1.5 border-r border-slate-200 bg-white pr-2 text-sm"
                :class="r.kind === 'epic' ? 'pl-1' : 'pl-7 text-xs'"
              >
                <button
                  v-if="r.kind === 'epic'"
                  class="w-5 shrink-0 rounded text-slate-500 hover:bg-slate-100 disabled:opacity-30"
                  :disabled="!r.issue.shown.length"
                  :aria-expanded="expanded.has(r.issue.key)"
                  :aria-label="`${expanded.has(r.issue.key) ? 'Hide' : 'Show'} the issues in ${r.issue.key}`"
                  @click="toggle(r.issue.key)"
                >
                  {{ expanded.has(r.issue.key) ? '▾' : '▸' }}
                </button>
                <TypeIcon :type="r.issue.type" :size="14" class="shrink-0" />
                <button
                  class="min-w-0 flex-1 truncate text-left hover:underline"
                  :title="`${r.issue.key} ${r.issue.title}`"
                  @click="openIssue(r.issue.key)"
                >
                  <span class="font-medium text-slate-500" :class="r.issue.status.category === 'done' ? 'line-through' : ''">{{
                    r.issue.key
                  }}</span>
                  <span class="hidden sm:inline">{{ r.issue.title }}</span>
                </button>
                <span
                  v-if="lateBy.has(r.issue.key)"
                  class="chip shrink-0 bg-red-100 text-red-800"
                  :title="`Starts before ${lateBy.get(r.issue.key).join(', ')} ends`"
                  >Early</span
                >
                <Avatar :user="r.issue.assignee" :size="r.kind === 'epic' ? 22 : 18" class="shrink-0" />
              </div>
              <div
                class="relative"
                :class="!barOf(r.issue) && canEdit(r.issue) ? 'cursor-crosshair touch-none' : ''"
                :style="{ width: width + 'px' }"
                :title="!barOf(r.issue) && canEdit(r.issue) ? `Drag across to set the start and due dates of ${r.issue.key}` : undefined"
                @pointerdown="onTrackDown($event, r.issue)"
              >
                <div
                  v-if="drawBar(r.issue)"
                  class="pointer-events-none absolute top-1/2 z-[15] -translate-y-1/2 rounded-full bg-accent/60 ring-2 ring-accent"
                  :class="r.kind === 'epic' ? 'h-6' : 'h-4'"
                  :style="{ left: drawBar(r.issue).x + 'px', width: drawBar(r.issue).w + 'px' }"
                >
                  <span class="absolute -top-5 left-0 whitespace-nowrap rounded bg-black px-1 text-[10px] text-white"
                    >{{ fmtDate(isoOf(drawBar(r.issue).a)) }} to {{ fmtDate(isoOf(drawBar(r.issue).b)) }}</span
                  >
                </div>
                <template v-if="barOf(r.issue)">
                  <!-- one date only: a dot -->
                  <div
                    v-if="barOf(r.issue).point"
                    class="absolute top-1/2 z-[15] h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 cursor-pointer rounded-[2px] border border-white"
                    :class="r.kind === 'epic' ? 'bg-link' : statusDot[r.issue.status.category]"
                    :style="{ left: barOf(r.issue).x + ppd / 2 + 'px' }"
                    tabindex="0"
                    role="button"
                    :title="barTitle(r.issue)"
                    :aria-label="barTitle(r.issue)"
                    @pointerdown="onPointerDown($event, r.issue, 'move')"
                    @keydown.enter="openIssue(r.issue.key)"
                  ></div>
                  <!-- bar -->
                  <div
                    v-else
                    class="group absolute top-1/2 z-[15] -translate-y-1/2 cursor-pointer touch-none overflow-hidden rounded-full"
                    :class="[
                      r.kind === 'epic'
                        ? 'h-6 bg-info/35 ring-1 ring-link/40'
                        : 'h-4 ' + (r.issue.status.category === 'done' ? 'bg-positive/70' : 'bg-slate-300'),
                      drag.key === r.issue.key && drag.moved ? 'ring-2 ring-accent' : '',
                    ]"
                    :style="{ left: barOf(r.issue).x + 'px', width: barOf(r.issue).w + 'px' }"
                    tabindex="0"
                    role="button"
                    :title="barTitle(r.issue)"
                    :aria-label="barTitle(r.issue)"
                    @pointerdown="onPointerDown($event, r.issue, 'move')"
                    @keydown.enter="openIssue(r.issue.key)"
                  >
                    <div
                      v-if="r.kind === 'epic'"
                      class="h-full bg-link/80"
                      :style="{ width: Math.round(r.issue.summary.progress * 100) + '%' }"
                    ></div>
                    <span
                      v-if="r.kind === 'epic' && barOf(r.issue).w > 60"
                      class="pointer-events-none absolute inset-0 flex items-center px-2.5 text-xs font-semibold text-black"
                      >{{ Math.round(r.issue.summary.progress * 100) }}%</span
                    >
                    <template v-if="canEdit(r.issue)">
                      <span
                        class="absolute inset-y-0 left-0 w-2 cursor-ew-resize opacity-0 group-hover:bg-black/20 group-hover:opacity-100"
                        aria-hidden="true"
                        @pointerdown="onPointerDown($event, r.issue, 'start')"
                      ></span>
                      <span
                        class="absolute inset-y-0 right-0 w-2 cursor-ew-resize opacity-0 group-hover:bg-black/20 group-hover:opacity-100"
                        aria-hidden="true"
                        @pointerdown="onPointerDown($event, r.issue, 'end')"
                      ></span>
                    </template>
                  </div>
                </template>
              </div>
            </template>
          </div>
        </div>
      </div>

      <section v-if="undated.length" class="mt-4">
        <h2 class="mb-2 text-sm font-semibold">
          No dates <span class="font-normal text-slate-500">{{ undated.length }} {{ plural(undated.length, 'epic') }}</span>
        </h2>
        <ul class="card divide-y divide-slate-100">
          <li v-for="e in undated" :key="e.key" class="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
            <TypeIcon :type="e.type" :size="14" />
            <button class="min-w-0 flex-1 truncate text-left hover:underline" @click="openIssue(e.key)">
              <span class="font-medium text-slate-500">{{ e.key }}</span> {{ e.title }}
            </button>
            <span class="text-xs text-slate-500">{{ progressText(e) }}</span>
            <template v-if="canEdit(e)">
              <form v-if="setting.key === e.key" class="flex flex-wrap items-center gap-1" @submit.prevent="saveSetDates(e)">
                <input v-model="setting.start" type="date" class="input w-auto py-0.5" aria-label="Start date" />
                <span class="text-xs text-slate-500">to</span>
                <input v-model="setting.due" type="date" class="input w-auto py-0.5" aria-label="Due date" />
                <button class="btn btn-sm btn-primary">Save</button>
                <button type="button" class="btn btn-sm" @click="setting.key = null">Cancel</button>
              </form>
              <button
                v-else
                class="btn btn-sm"
                :title="e.summary.suggestedStart ? 'Starts with the dates of its issues' : ''"
                @click="startSetDates(e)"
              >
                Set dates
              </button>
            </template>
          </li>
        </ul>
      </section>
      <p v-if="rows.length" class="mt-2 text-xs text-slate-500">
        Drag a bar to move it, or drag an end to change one date. On a row with no dates, drag across the timeline to set them. Click a bar
        to open the issue. Arrows show blocking links; red ones start before their blocker ends.
      </p>
    </template>
  </div>
</template>
