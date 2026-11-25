<script setup>
import { computed, inject, reactive } from 'vue';
import { get, post, toast, qs, session } from '../../api.js';
import { ui, changed, openIssue } from '../../ui.js';
import { fmtDate, blockedText } from '../../meta.js';
import { today as localToday } from '../../dates.js';
import TypeIcon from '../../components/TypeIcon.vue';
import PriorityIcon from '../../components/PriorityIcon.vue';
import Avatar from '../../components/Avatar.vue';
import Skeleton from '../../components/Skeleton.vue';
import BlockedBadge from '../../components/BlockedBadge.vue';
import BoardViews from '../../components/BoardViews.vue';
import { canMoveTo, moveRefusal, withWorkflow } from '../../workflow.js';
import { updateIssue } from '../../issues.js';
import { useLoad } from '../../composables/useLoad.js';
import LoadState from '../../components/LoadState.vue';
import { attempt } from '../../composables/useAction.js';

const project = inject('project');
const activeSprint = computed(() => project.value.sprints.find((s) => s.state === 'active'));
const f = reactive({
  scope: activeSprint.value ? 'sprint' : 'all',
  text: '',
  mine: false,
  assignees: [],
  type: '',
  label: '',
  subtasks: false,
  lanes: 'none',
  oldDone: false,
});

// Saved board views (components/BoardViews.vue): apply a view's filters; a sprint view falls back to all issues.
function applyView(v) {
  Object.assign(f, v);
  if (f.scope === 'sprint' && !activeSprint.value) f.scope = 'all';
}

const {
  data: issues,
  loading,
  error: loadError,
  reload: load,
} = useLoad(
  async () => {
    const params = { project: project.value.key, sort: 'rank', limit: 1000, noSubtasks: f.subtasks ? '' : '1' };
    if (f.scope === 'sprint' && activeSprint.value) params.sprint = activeSprint.value.id;
    return (await get(`/api/issues?${qs(params)}`)).issues;
  },
  () => [f.scope, f.subtasks, ui.changes],
  { initial: [] },
);

const today = localToday();
const cutoff = new Date(Date.now() - 14 * 864e5).toISOString();
const visible = computed(() => {
  const t = f.text.toLowerCase();
  return issues.value.filter(
    (i) =>
      (!t || i.title.toLowerCase().includes(t) || i.key.toLowerCase().includes(t)) &&
      (!f.mine || i.assignee?.id === session.user.id) &&
      (!f.assignees.length || f.assignees.includes(i.assignee?.id || 'none')) &&
      (!f.type || i.type === f.type) &&
      (!f.label || i.labels.includes(f.label)) &&
      (f.oldDone || f.scope === 'sprint' || i.status.category !== 'done' || !i.resolvedAt || i.resolvedAt >= cutoff),
  );
});
const people = computed(() => {
  const m = new Map();
  for (const i of issues.value) if (i.assignee) m.set(i.assignee.id, i.assignee);
  return [...m.values()];
});
const labels = computed(() => [...new Set(issues.value.flatMap((i) => i.labels))].sort());
const hiddenDone = computed(() => issues.value.filter((i) => i.status.category === 'done' && i.resolvedAt && i.resolvedAt < cutoff).length);

const lanes = computed(() => {
  if (f.lanes === 'none') return [{ id: 'all', title: null, issues: visible.value }];
  const groups = new Map();
  for (const i of visible.value) {
    let id;
    let title;
    let user = null;
    if (f.lanes === 'assignee') {
      id = i.assignee?.id || 'none';
      title = i.assignee?.name || 'Unassigned';
      user = i.assignee;
    } else {
      id = i.parent?.type === 'epic' ? i.parent.key : 'none';
      title = i.parent?.type === 'epic' ? `${i.parent.key} ${i.parent.title}` : 'No epic';
    }
    if (!groups.has(id)) groups.set(id, { id, title, user, issues: [] });
    groups.get(id).issues.push(i);
  }
  return [...groups.values()].sort((a, b) => (a.id === 'none') - (b.id === 'none') || a.title.localeCompare(b.title));
});
const columnIssues = (lane, statusId) => lane.issues.filter((i) => i.status.id === statusId);
const columnCount = (statusId) => visible.value.filter((i) => i.status.id === statusId).length;

// ---- drag and drop ----
const drag = reactive({ key: null, lane: null, statusId: null, index: null, from: null });
// workflow rules: columns the dragged card may not move to are dimmed
const refused = (statusId) => Boolean(drag.key) && !canMoveTo(project.value, drag.from, statusId);
function onDragStart(e, issue, lane) {
  drag.key = issue.key;
  drag.from = issue.status.id;
  drag.fromLane = lane.id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', issue.key);
}
function onDragOverCard(e, lane, statusId, index) {
  const r = e.currentTarget.getBoundingClientRect();
  drag.lane = lane.id;
  drag.statusId = statusId;
  drag.index = e.clientY > r.top + r.height / 2 ? index + 1 : index;
}
function onDragOverColumn(e, lane, statusId) {
  if (drag.lane === lane.id && drag.statusId === statusId && e.target !== e.currentTarget) return;
  drag.lane = lane.id;
  drag.statusId = statusId;
  if (e.target === e.currentTarget) drag.index = columnIssues(lane, statusId).length;
}
function endDrag() {
  Object.assign(drag, { key: null, lane: null, statusId: null, index: null, from: null });
}
async function onDrop(lane, statusId) {
  const key = drag.key;
  const list = columnIssues(lane, statusId);
  const moving = issues.value.find((i) => i.key === key);
  if (!moving) return endDrag();
  let index = drag.index ?? list.length;
  const without = list.filter((i) => i.key !== key);
  const oldIndex = list.findIndex((i) => i.key === key);
  if (oldIndex >= 0 && oldIndex < index) index--;
  const prev = without[index - 1];
  const next = without[index];
  const body = { prevKey: prev?.key, nextKey: next?.key };
  if (moving.status.id !== statusId) body.statusId = statusId;
  const fromLane = drag.fromLane;
  endDrag();
  if (!body.statusId && oldIndex === index) return;
  if (body.statusId && !canMoveTo(project.value, moving.status.id, statusId))
    return toast(moveRefusal(project.value, moving.status.id, statusId), 'error');
  // optimistic: reorder locally
  const st = project.value.statuses.find((s) => s.id === statusId);
  // warn (not stop) when a blocked issue moves to an in-progress or done column
  if (body.statusId && moving.blocked && st.category !== 'todo') toast(`${key} is ${blockedText(moving).replace(/^B/, 'b')}`, 'warn');
  moving.status = { id: st.id, name: st.name, category: st.category };
  moving.rank = prev && next ? (prev.rank + next.rank) / 2 : prev ? prev.rank + 1 : next ? next.rank - 1 : moving.rank;
  issues.value = [...issues.value].sort((a, b) => a.rank - b.rank);
  try {
    // a workflow rule may ask for values first (dialog), then the move is sent again with them as extra
    await withWorkflow(project.value, (extra) => post(`/api/issues/${key}/move`, Object.keys(extra).length ? { ...body, extra } : body));
    if (f.lanes === 'assignee' && lane.id !== fromLane) await updateIssue(key, { assigneeId: lane.id === 'none' ? null : lane.id });
    if (f.lanes === 'epic' && lane.id !== fromLane) await updateIssue(key, { parentKey: lane.id === 'none' ? null : lane.id });
  } catch (e) {
    if (!e.cancelled) toast(e.message, 'error');
  }
  changed();
}

// ---- quick create ----
const quick = reactive({ statusId: null, title: '' });
async function quickCreate() {
  if (!quick.title.trim()) return;
  await attempt(async () => {
    await post('/api/issues', {
      projectKey: project.value.key,
      title: quick.title,
      statusId: quick.statusId,
      sprintId: f.scope === 'sprint' && project.value.canSprints ? activeSprint.value?.id : null,
      assigneeId: f.mine ? session.user.id : null,
    });
    quick.title = '';
    changed();
  });
}

function toggleAssignee(id) {
  f.assignees = f.assignees.includes(id) ? f.assignees.filter((x) => x !== id) : [...f.assignees, id];
}
const daysLeft = computed(() => {
  if (!activeSprint.value?.endDate) return null;
  return Math.ceil((new Date(`${activeSprint.value.endDate}T23:59:59`) - Date.now()) / 864e5);
});
</script>

<template>
  <div class="mb-3 flex flex-wrap items-center gap-2">
    <BoardViews :key="project.key" :project-key="project.key" :filters="f" @apply="applyView" />
    <select v-if="activeSprint" v-model="f.scope" class="input w-auto" aria-label="Board scope">
      <option value="sprint">{{ activeSprint.name }}</option>
      <option value="all">All issues</option>
    </select>
    <span v-if="f.scope === 'sprint' && daysLeft !== null" class="text-xs text-slate-500">{{
      daysLeft >= 0 ? `${daysLeft} days left` : `ended ${-daysLeft} days ago`
    }}</span>
    <input v-model="f.text" class="input w-48" placeholder="Filter board" />
    <div class="flex flex-wrap items-center gap-1">
      <button
        v-for="p in people"
        :key="p.id"
        class="rounded-full border py-0.5 pl-0.5 pr-2 text-xs"
        :class="
          f.assignees.includes(p.id)
            ? 'border-blue-600 bg-blue-50 text-blue-900'
            : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
        "
        :aria-pressed="f.assignees.includes(p.id)"
        @click="toggleAssignee(p.id)"
      >
        <Avatar :user="p" :size="20" label="short" />
      </button>
      <button
        v-if="issues.some((i) => !i.assignee)"
        class="rounded-full border py-0.5 pl-0.5 pr-2 text-xs"
        :class="
          f.assignees.includes('none')
            ? 'border-blue-600 bg-blue-50 text-blue-900'
            : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
        "
        :aria-pressed="f.assignees.includes('none')"
        @click="toggleAssignee('none')"
      >
        <Avatar :user="null" :size="20" label="short" />
      </button>
    </div>
    <button class="btn btn-sm" :class="f.mine ? 'btn-primary' : ''" @click="f.mine = !f.mine">Only my issues</button>
    <select v-model="f.type" class="input w-auto py-1" aria-label="Type">
      <option value="">All types</option>
      <option value="story">Stories</option>
      <option value="task">Tasks</option>
      <option value="bug">Bugs</option>
      <option value="epic">Epics</option>
    </select>
    <select v-if="labels.length" v-model="f.label" class="input w-auto py-1">
      <option value="">All labels</option>
      <option v-for="l in labels" :key="l" :value="l">{{ l }}</option>
    </select>
    <div class="ml-auto flex items-center gap-3 text-sm text-slate-600">
      <label class="flex items-center gap-1"><input v-model="f.subtasks" type="checkbox" /> Sub-tasks</label>
      <label class="flex items-center gap-1"
        >Group by
        <select v-model="f.lanes" class="input w-auto py-1">
          <option value="none">None</option>
          <option value="assignee">Assignee</option>
          <option value="epic">Epic</option>
        </select>
      </label>
    </div>
  </div>
  <p v-if="activeSprint && f.scope === 'sprint' && activeSprint.goal" class="mb-2 text-sm text-slate-600">
    <strong>Sprint goal:</strong> {{ activeSprint.goal }}
  </p>
  <p v-if="!activeSprint && !loading && !loadError && !issues.length" class="mb-3 rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-900">
    This board shows every issue in the project. Create one with the + on a column, or plan sprints in the Backlog.
  </p>

  <LoadState v-if="loadError" class="mb-3" :error="loadError" @retry="load" />
  <div class="snap-x snap-mandatory overflow-x-auto pb-4 lg:snap-none">
    <div class="min-w-max">
      <div class="flex gap-3">
        <div
          v-for="s in project.statuses"
          :key="s.id"
          class="w-[min(18rem,85vw)] shrink-0 px-1 py-1 text-xs font-semibold uppercase text-slate-500"
        >
          <div class="flex items-center gap-2">
            {{ s.name }}
            <span
              class="rounded-full px-1.5"
              :class="s.wipLimit && columnCount(s.id) > s.wipLimit ? 'bg-red-600 text-white' : 'bg-slate-200 text-slate-600'"
              >{{ columnCount(s.id) }}<template v-if="s.wipLimit"> / {{ s.wipLimit }}</template></span
            >
            <button
              v-if="project.canCreate"
              class="ml-auto rounded px-1.5 text-base leading-none text-slate-500 hover:bg-slate-200"
              :aria-label="'Create in ' + s.name"
              @click="
                quick.statusId = s.id;
                quick.title = '';
              "
            >
              +
            </button>
          </div>
        </div>
      </div>
      <div v-if="loading" class="flex gap-3">
        <div v-for="n in 3" :key="n" class="w-[min(18rem,85vw)] shrink-0 rounded-[15px] bg-slate-100 p-1.5">
          <Skeleton card :rows="3 - (n % 2)" />
        </div>
      </div>
      <div v-for="lane in loading ? [] : lanes" :key="lane.id" class="mb-3">
        <div v-if="lane.title" class="mb-1 flex items-center gap-2 px-1 text-sm font-semibold text-slate-700">
          <Avatar v-if="f.lanes === 'assignee'" :user="lane.user" :size="20" />{{ lane.title }}
          <span class="text-xs font-normal text-slate-500">{{ lane.issues.length }} issues</span>
        </div>
        <div class="flex gap-3">
          <div
            v-for="s in project.statuses"
            :key="s.id"
            class="min-h-24 w-[min(18rem,85vw)] shrink-0 snap-start rounded-[15px] p-1.5 transition-colors"
            :class="[
              drag.key && drag.lane === lane.id && drag.statusId === s.id
                ? refused(s.id)
                  ? 'bg-red-50 ring-2 ring-red-300'
                  : 'bg-blue-50 ring-2 ring-blue-300'
                : 'bg-slate-100',
              refused(s.id) ? 'opacity-50' : '',
            ]"
            @dragover.prevent="onDragOverColumn($event, lane, s.id)"
            @drop.prevent="onDrop(lane, s.id)"
          >
            <form v-if="quick.statusId === s.id && lane === lanes[0]" class="mb-1.5" @submit.prevent="quickCreate">
              <textarea
                v-model="quick.title"
                class="input text-sm"
                rows="2"
                placeholder="What needs to be done?"
                autofocus
                @keydown.enter.exact.prevent="quickCreate"
                @keydown.esc="quick.statusId = null"
              ></textarea>
              <div class="mt-1 flex gap-1">
                <button class="btn btn-primary btn-sm">Create</button
                ><button type="button" class="btn btn-sm" @click="quick.statusId = null">Cancel</button>
              </div>
            </form>
            <template v-for="(i, idx) in columnIssues(lane, s.id)" :key="i.id">
              <div
                v-if="drag.key && drag.lane === lane.id && drag.statusId === s.id && drag.index === idx"
                class="mb-1.5 h-1 rounded bg-blue-500"
              ></div>
              <div
                class="mb-1.5 cursor-pointer rounded-md border border-slate-200 bg-white p-2.5 shadow-sm hover:border-blue-300"
                :class="drag.key === i.key ? 'opacity-40' : ''"
                :draggable="project.canEdit"
                @dragstart="onDragStart($event, i, lane)"
                @dragend="endDrag"
                @dragover.prevent.stop="onDragOverCard($event, lane, s.id, idx)"
                @drop.prevent.stop="onDrop(lane, s.id)"
                @click="openIssue(i.key)"
              >
                <div class="mb-2 text-sm leading-snug" :class="i.status.category === 'done' ? 'text-slate-500' : ''">{{ i.title }}</div>
                <div v-if="i.parent?.type === 'epic' || i.labels.length || i.blocked" class="mb-2 flex flex-wrap gap-1">
                  <BlockedBadge :issue="i" />
                  <span v-if="i.parent?.type === 'epic'" class="chip bg-violet-100 text-violet-800">{{ i.parent.title }}</span>
                  <span v-for="l in i.labels" :key="l" class="chip bg-slate-100 text-slate-600">{{ l }}</span>
                </div>
                <div class="flex items-center gap-1.5 text-xs text-slate-500">
                  <TypeIcon :type="i.type" :size="14" />
                  <span class="shrink-0 whitespace-nowrap font-medium" :class="i.status.category === 'done' ? 'line-through' : ''">{{
                    i.key
                  }}</span>
                  <span
                    v-if="i.dueDate"
                    class="chip shrink-0 whitespace-nowrap"
                    :class="i.dueDate < today && i.status.category !== 'done' ? 'bg-red-100 text-red-800' : 'bg-slate-100'"
                    >{{ fmtDate(i.dueDate) }}</span
                  >
                  <span class="ml-auto flex min-w-0 items-center gap-1.5">
                    <span
                      v-if="i.storyPoints !== null"
                      class="rounded-full bg-slate-200 px-1.5 font-semibold text-slate-700"
                      title="Story points"
                      >{{ i.storyPoints }}</span
                    >
                    <PriorityIcon :priority="i.priority" />
                    <Avatar :user="i.assignee" :size="20" label="short" class="max-w-[7.5rem] text-slate-600" />
                  </span>
                </div>
              </div>
            </template>
            <div
              v-if="drag.key && drag.lane === lane.id && drag.statusId === s.id && drag.index === columnIssues(lane, s.id).length"
              class="mb-1.5 h-1 rounded bg-blue-500"
            ></div>
          </div>
        </div>
      </div>
      <p v-if="hiddenDone && f.scope !== 'sprint'" class="px-1 text-xs text-slate-500">
        {{ f.oldDone ? '' : `${hiddenDone} issues done more than 14 days ago are hidden.` }}
        <button class="link" @click="f.oldDone = !f.oldDone">{{ f.oldDone ? 'Hide old done issues' : 'Show them' }}</button>
      </p>
    </div>
  </div>
</template>
