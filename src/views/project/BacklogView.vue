<script setup>
import { ref, computed, inject, watch, reactive } from 'vue';
import { get, post, patch, del, toast, qs } from '../../api.js';
import { ui, changed, openIssue } from '../../ui.js';
import { fmtDate } from '../../meta.js';
import { today, addDays } from '../../dates.js';
import TypeIcon from '../../components/TypeIcon.vue';
import PriorityIcon from '../../components/PriorityIcon.vue';
import StatusBadge from '../../components/StatusBadge.vue';
import BlockedBadge from '../../components/BlockedBadge.vue';
import Avatar from '../../components/Avatar.vue';
import Modal from '../../components/Modal.vue';
import ImportIssues from '../../components/ImportIssues.vue';
import { attempt } from '../../composables/useAction.js';
import { useLoad } from '../../composables/useLoad.js';
import LoadState from '../../components/LoadState.vue';

const project = inject('project');
const reloadProject = inject('reloadProject');
const text = ref('');
const sprintModal = ref(null); // { mode: 'create'|'edit'|'start', sprint, form }
const completeModal = ref(null);
const importing = ref(false);

const {
  data: issues,
  loading,
  error: loadError,
  reload: load,
} = useLoad(
  async () =>
    (await get(`/api/issues?${qs({ project: project.value.key, sprint: 'open', sort: 'rank', noSubtasks: '1', limit: 1000 })}`)).issues,
  () => ui.changes,
  { initial: [] },
);

// Sprint hint: the team's available hours in each sprint against its estimated remaining work (not for guests).
const sprintCap = ref({});
const CAP_WORDS = { none: 'no hours', light: 'light', good: 'good', over: 'over', overloaded: 'overloaded' };
async function loadSprintCap() {
  if (project.value.guest) return;
  try {
    sprintCap.value = Object.fromEntries((await get(`/api/projects/${project.value.key}/sprint-capacity`)).sprints.map((s) => [s.id, s]));
  } catch {
    sprintCap.value = {};
  }
}
watch(
  [() => ui.changes, () => project.value.key, () => project.value.sprints.map((s) => `${s.id}${s.startDate}${s.endDate}`).join()],
  loadSprintCap,
  { immediate: true },
);
const capText = (c) =>
  `Team: ${c.available} h available, ${c.remaining} h estimated left (${c.pct === null ? '' : `${c.pct}%, `}${CAP_WORDS[c.level]})`;
const capCls = (c) =>
  ({ over: 'bg-amber-100 text-amber-950', overloaded: 'bg-red-100 text-red-900', good: 'bg-green-100 text-green-900' })[c.level] ||
  'bg-white text-slate-700';

const sprints = computed(() =>
  [...project.value.sprints].sort((a, b) =>
    a.state === 'active' ? -1 : b.state === 'active' ? 1 : a.createdAt.localeCompare(b.createdAt),
  ),
);
const match = (i) =>
  !text.value || i.title.toLowerCase().includes(text.value.toLowerCase()) || i.key.toLowerCase().includes(text.value.toLowerCase());
const sections = computed(() => [
  ...sprints.value.map((s) => ({ id: s.id, sprint: s, issues: issues.value.filter((i) => i.sprint?.id === s.id && match(i)) })),
  { id: 'backlog', sprint: null, issues: issues.value.filter((i) => !i.sprint && i.status.category !== 'done' && match(i)) },
]);
const points = (list) => list.reduce((s, i) => s + (Number(i.storyPoints) || 0), 0);
const counts = (list) => ({
  todo: list.filter((i) => i.status.category === 'todo').length,
  in_progress: list.filter((i) => i.status.category === 'in_progress').length,
  done: list.filter((i) => i.status.category === 'done').length,
});

// ---- drag ----
const drag = reactive({ key: null, section: null, index: null });
function over(e, section, idx) {
  const r = e.currentTarget.getBoundingClientRect();
  drag.section = section.id;
  drag.index = e.clientY > r.top + r.height / 2 ? idx + 1 : idx;
}
function overSection(e, section) {
  if (e.target !== e.currentTarget) return;
  drag.section = section.id;
  drag.index = section.issues.length;
}
async function drop(section) {
  const key = drag.key;
  const list = section.issues;
  let index = drag.index ?? list.length;
  const oldIndex = list.findIndex((i) => i.key === key);
  if (oldIndex >= 0 && oldIndex < index) index--;
  const without = list.filter((i) => i.key !== key);
  const moving = issues.value.find((i) => i.key === key);
  Object.assign(drag, { key: null, section: null, index: null });
  if (!moving) return;
  const body = { prevKey: without[index - 1]?.key, nextKey: without[index]?.key };
  const target = section.sprint ? section.sprint.id : null;
  if ((moving.sprint?.id || null) !== target) body.sprintId = target || 'backlog';
  else if (oldIndex === index) return;
  await attempt(() => post(`/api/issues/${key}/move`, body));
  changed();
}

// ---- quick create ----
const quick = reactive({ section: null, title: '' });
async function quickCreate(section) {
  if (!quick.title.trim()) return;
  await attempt(async () => {
    await post('/api/issues', {
      projectKey: project.value.key,
      title: quick.title,
      sprintId: section.sprint?.id || null,
      type: quick.type || 'task',
    });
    quick.title = '';
    changed();
  });
}

// ---- sprints ----
const twoWeeks = () => addDays(today(), 14);
async function createSprint() {
  await post(`/api/projects/${project.value.key}/sprints`, {});
  await reloadProject();
}
function openSprint(mode, s) {
  const start = s.startDate || today();
  sprintModal.value = { mode, sprint: s, form: { name: s.name, goal: s.goal || '', startDate: start, endDate: s.endDate || twoWeeks() } };
}
async function saveSprint() {
  const { mode, sprint, form } = sprintModal.value;
  await attempt(async () => {
    await patch(`/api/sprints/${sprint.id}`, form);
    if (mode === 'start') await post(`/api/sprints/${sprint.id}/start`, { startDate: form.startDate, endDate: form.endDate });
    sprintModal.value = null;
    await reloadProject();
    changed();
    if (mode === 'start') toast(`${form.name} started`);
  });
}
function openComplete(section) {
  const c = counts(section.issues);
  completeModal.value = { sprint: section.sprint, done: c.done, open: c.todo + c.in_progress, moveTo: 'backlog' };
}
async function complete() {
  await attempt(async () => {
    const r = await post(`/api/sprints/${completeModal.value.sprint.id}/complete`, { moveTo: completeModal.value.moveTo });
    toast(`Sprint completed. ${r.movedIssues} open issues moved.`);
    completeModal.value = null;
    await reloadProject();
    changed();
  });
}
async function removeSprint(s) {
  if (!confirm(`Delete ${s.name}? Its issues go back to the backlog.`)) return;
  await del(`/api/sprints/${s.id}`);
  await reloadProject();
  changed();
}
const hasActive = computed(() => project.value.sprints.some((s) => s.state === 'active'));
</script>

<template>
  <div class="mb-3 flex items-center gap-2">
    <input v-model="text" class="input w-60" placeholder="Filter backlog" />
    <button v-if="project.canSprints" class="btn ml-auto" @click="createSprint">Create sprint</button>
    <button v-else-if="project.canEdit" class="btn ml-auto" disabled title="Only project admins can manage sprints in this project">
      Create sprint
    </button>
    <button v-if="project.canEdit && project.canCreate" class="btn" @click="importing = true">Import issues</button>
  </div>
  <LoadState v-if="loading || loadError" :loading="loading" :error="loadError" card :rows="5" @retry="load" />
  <div v-else class="space-y-4">
    <section
      v-for="sec in sections"
      :key="sec.id"
      class="rounded-[15px] bg-slate-100 p-2"
      :class="drag.key && drag.section === sec.id ? 'ring-2 ring-blue-300' : ''"
      @dragover.prevent="overSection($event, sec)"
      @drop.prevent="drop(sec)"
    >
      <div class="flex flex-wrap items-center gap-2 px-1 pb-2">
        <h2 class="text-sm font-semibold">{{ sec.sprint ? sec.sprint.name : 'Backlog' }}</h2>
        <span v-if="sec.sprint?.state === 'active'" class="chip bg-green-100 text-green-800">Active</span>
        <span v-if="sec.sprint?.startDate" class="text-xs text-slate-500"
          >{{ fmtDate(sec.sprint.startDate) }} to {{ fmtDate(sec.sprint.endDate) }}</span
        >
        <span class="text-xs text-slate-500">{{ sec.issues.length }} issues · {{ points(sec.issues) }} points</span>
        <RouterLink
          v-if="sec.sprint && sprintCap[sec.sprint.id]"
          :to="`/capacity?project=${project.key}`"
          class="chip hover:underline"
          :class="capCls(sprintCap[sec.sprint.id])"
          :title="`${sprintCap[sec.sprint.id].people} people, weekdays ${sprintCap[sec.sprint.id].from} to ${sprintCap[sec.sprint.id].to}, after time off and allocations${sprintCap[sec.sprint.id].unestimated ? `; ${sprintCap[sec.sprint.id].unestimated} issues without an estimate` : ''}`"
          >{{ capText(sprintCap[sec.sprint.id]) }}</RouterLink
        >
        <span v-if="sec.sprint" class="flex gap-1 text-xs">
          <span class="chip bg-slate-200">{{ counts(sec.issues).todo }}</span><span class="chip bg-blue-100 text-blue-800">{{
            counts(sec.issues).in_progress
          }}</span
          ><span class="chip bg-green-100 text-green-800">{{ counts(sec.issues).done }}</span>
        </span>
        <div v-if="sec.sprint && project.canSprints" class="ml-auto flex gap-1">
          <button
            v-if="sec.sprint.state === 'future'"
            class="btn btn-sm"
            :disabled="hasActive"
            :title="hasActive ? 'Complete the active sprint first' : ''"
            @click="openSprint('start', sec.sprint)"
          >
            Start sprint
          </button>
          <button v-if="sec.sprint.state === 'active'" class="btn btn-sm btn-primary" @click="openComplete(sec)">Complete sprint</button>
          <button class="btn btn-sm btn-ghost" @click="openSprint('edit', sec.sprint)">Edit</button>
          <button v-if="sec.sprint.state === 'future'" class="btn btn-sm btn-ghost" @click="removeSprint(sec.sprint)">Delete</button>
        </div>
      </div>
      <p v-if="sec.sprint?.goal" class="px-1 pb-2 text-xs text-slate-600">Goal: {{ sec.sprint.goal }}</p>
      <div class="overflow-hidden rounded-md border border-slate-200 bg-white" @dragover.prevent>
        <template v-for="(i, idx) in sec.issues" :key="i.id">
          <div v-if="drag.key && drag.section === sec.id && drag.index === idx" class="h-0.5 bg-blue-500"></div>
          <div
            class="flex cursor-pointer items-center gap-2 border-b border-slate-100 px-3 py-1.5 text-sm hover:bg-slate-50"
            :class="drag.key === i.key ? 'opacity-40' : ''"
            :draggable="project.canSprints"
            @dragstart="
              drag.key = i.key;
              $event.dataTransfer.setData('text/plain', i.key);
            "
            @dragend="drag.key = null"
            @dragover.prevent.stop="over($event, sec, idx)"
            @drop.prevent.stop="drop(sec)"
            @click="openIssue(i.key)"
          >
            <TypeIcon :type="i.type" />
            <span class="w-20 shrink-0 text-slate-500" :class="i.status.category === 'done' ? 'line-through' : ''">{{ i.key }}</span>
            <span class="flex-1 truncate">{{ i.title }}</span>
            <BlockedBadge :issue="i" compact />
            <span v-if="i.parent?.type === 'epic'" class="chip hidden bg-violet-100 text-violet-800 md:inline-flex">{{
              i.parent.title
            }}</span>
            <StatusBadge :status="i.status" />
            <span class="w-6 text-center text-xs text-slate-600">{{ i.storyPoints ?? '' }}</span>
            <PriorityIcon :priority="i.priority" />
            <Avatar :user="i.assignee" :size="22" label="short" class="w-28 text-slate-600" />
          </div>
        </template>
        <div v-if="drag.key && drag.section === sec.id && drag.index === sec.issues.length" class="h-0.5 bg-blue-500"></div>
        <p v-if="!sec.issues.length" class="px-3 py-4 text-center text-xs text-slate-500">
          {{ sec.sprint ? 'Drag issues here to plan this sprint.' : 'The backlog is empty.' }}
        </p>
        <form v-if="quick.section === sec.id" class="flex gap-2 p-2" @submit.prevent="quickCreate(sec)">
          <select v-model="quick.type" class="input w-28">
            <option value="task">Task</option>
            <option value="story">Story</option>
            <option value="bug">Bug</option>
            <option value="epic">Epic</option>
          </select>
          <input v-model="quick.title" class="input" placeholder="What needs to be done?" autofocus @keydown.esc="quick.section = null" />
          <button class="btn btn-primary">Create</button>
        </form>
        <button
          v-else-if="project.canCreate && (!sec.sprint || project.canSprints)"
          class="w-full px-3 py-1.5 text-left text-sm text-slate-600 hover:bg-slate-50"
          @click="
            quick.section = sec.id;
            quick.title = '';
            quick.type = 'task';
          "
        >
          + Create issue
        </button>
      </div>
    </section>
  </div>

  <Modal
    v-if="sprintModal"
    :title="sprintModal.mode === 'start' ? `Start ${sprintModal.sprint.name}` : 'Edit sprint'"
    @close="sprintModal = null"
  >
    <form id="sprint-form" class="space-y-3" @submit.prevent="saveSprint">
      <div>
        <label class="label" for="sp-name">Name</label><input id="sp-name" v-model="sprintModal.form.name" class="input" required />
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="label" for="sp-start">Start date</label
          ><input id="sp-start" v-model="sprintModal.form.startDate" type="date" class="input" :required="sprintModal.mode === 'start'" />
        </div>
        <div>
          <label class="label" for="sp-end">End date</label
          ><input id="sp-end" v-model="sprintModal.form.endDate" type="date" class="input" :required="sprintModal.mode === 'start'" />
        </div>
      </div>
      <div>
        <label class="label" for="sp-goal">Sprint goal</label
        ><textarea id="sp-goal" v-model="sprintModal.form.goal" class="input" rows="2"></textarea>
      </div>
    </form>
    <template #footer
      ><button class="btn" @click="sprintModal = null">Cancel</button
      ><button class="btn btn-primary" form="sprint-form">{{ sprintModal.mode === 'start' ? 'Start' : 'Save' }}</button></template
    >
  </Modal>

  <Modal v-if="completeModal" :title="`Complete ${completeModal.sprint.name}`" @close="completeModal = null">
    <p class="text-sm">{{ completeModal.done }} issues are done. {{ completeModal.open }} are not.</p>
    <div v-if="completeModal.open" class="mt-3">
      <label class="label" for="cs-move">Move the open issues to</label>
      <select id="cs-move" v-model="completeModal.moveTo" class="input">
        <option value="backlog">Backlog</option>
        <option v-for="s in project.sprints.filter((s) => s.state === 'future')" :key="s.id" :value="s.id">{{ s.name }}</option>
      </select>
    </div>
    <template #footer
      ><button class="btn" @click="completeModal = null">Cancel</button
      ><button class="btn btn-primary" @click="complete">Complete sprint</button></template
    >
  </Modal>
  <ImportIssues v-if="importing" :project-key="project.key" @close="importing = false" @imported="changed()" />
</template>
