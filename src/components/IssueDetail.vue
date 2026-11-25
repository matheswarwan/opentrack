<script setup>
import { timerState, startTimer, askStop } from '../timer.js';
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import { get, post, del, toast, session } from '../api.js';
import { copyText } from '../browser.js';
import { ui, changed, openCreate } from '../ui.js';
import { TYPES, PRIORITIES, typeOf, ago, fmtDateTime } from '../meta.js';
import TypeIcon from './TypeIcon.vue';
import StatusBadge from './StatusBadge.vue';
import Avatar from './Avatar.vue';
import UserSelect from './UserSelect.vue';
import LabelsInput from './LabelsInput.vue';
import Markdown from './Markdown.vue';
import MarkdownEditor from './MarkdownEditor.vue';
import Skeleton from './Skeleton.vue';
import IssueAttachments from './IssueAttachments.vue';
import IssueChannels from './IssueChannels.vue';
import IssueRaid from './IssueRaid.vue';
import Icon from './Icon.vue';
import IssueFields from './IssueFields.vue';
import MultiPick from './MultiPick.vue';
import { versionOptions, componentOptions } from '../releases.js';
import CommentThread from './CommentThread.vue';
import { updateIssue } from '../issues.js';
import { project as fetchProject } from '../projects.js';
import StatusSelect from './StatusSelect.vue';
import { attempt } from '../composables/useAction.js';
import { useFileDrop } from '../composables/useFileDrop.js';
import FieldRow from './FieldRow.vue';
import IssueChildren from './IssueChildren.vue';
import IssueDependencies from './IssueDependencies.vue';
import IssueLinks from './IssueLinks.vue';
import IssueHistory from './IssueHistory.vue';
import IssueWorklog from './IssueWorklog.vue';
import IssueWatchers from './IssueWatchers.vue';

const props = defineProps({ issueKey: String, panel: Boolean });
const emit = defineEmits(['close', 'deleted']);
const router = useRouter();
const issue = ref(null);
const project = ref(null);
const epics = ref([]);
const notFound = ref('');
const editingTitle = ref(false);
const titleDraft = ref('');
const editingDesc = ref(false);
const descDraft = ref('');
const comment = ref('');
const tab = ref('comments');
const attachmentsRef = ref(null);
// files dropped anywhere on the issue become attachments
const { dragging, onDragEnter, onDragOver, onDragLeave, onDrop } = useFileDrop({
  enabled: () => canEdit.value,
  onFiles: (files) => attachmentsRef.value?.upload(files),
});

async function load() {
  try {
    const r = await get(`/api/issues/${props.issueKey}`);
    issue.value = r.issue;
    notFound.value = '';
    if (!project.value || project.value.key !== r.issue.projectKey) {
      project.value = await fetchProject(r.issue.projectKey);
      epics.value = (await get(`/api/issues?project=${r.issue.projectKey}&type=epic&limit=300&sort=key`)).issues;
    }
    ui.lastProjectKey = r.issue.projectKey;
  } catch (e) {
    notFound.value = e.message;
    issue.value = null;
  }
}
watch(
  () => props.issueKey,
  () => {
    project.value = null;
    load();
  },
  { immediate: true },
);
watch(
  () => ui.changes,
  () => issue.value && load(),
);

const canEdit = computed(() => issue.value?.canEdit && session.user.role !== 'viewer');
// Guests (external clients): no internal notes, no reporter or sprint changes. Commenting follows the project's permission.
const isGuest = computed(() => session.user.role === 'guest');
const canComment = computed(() => Boolean(issue.value?.canComment) && session.user.role !== 'viewer');
const internalNote = ref(false);
// Comment threads, newest first; replies stay in the order they were written under their top comment.
const threads = computed(() => {
  const list = issue.value?.comments || [];
  const byParent = new Map();
  for (const c of list) if (c.parentId) byParent.set(c.parentId, [...(byParent.get(c.parentId) || []), c]);
  return list
    .filter((c) => !c.parentId)
    .reverse()
    .map((c) => ({ id: c.id, comment: c, replies: byParent.get(c.id) || [] }));
});
const commentCount = computed(() => (issue.value?.comments || []).filter((c) => !c.deleted).length);
const sprintReason = computed(() =>
  issue.value?.canSprints
    ? ''
    : isGuest.value
      ? 'Guests cannot move issues between sprints'
      : 'Only project admins can manage sprints in this project',
);
const isSub = computed(() => issue.value?.type === 'subtask');

const reloadAll = () => {
  load();
  changed();
}; // a part of the page changed something other views show too
// after a save: reload the issue and tell other views, when something did change
async function saved(r) {
  if (!r.changed.length) return;
  await load();
  changed();
}
const update = (change) => attempt(() => updateIssue(issue.value.key, change), { then: saved });
function startTitle() {
  if (!canEdit.value) return;
  titleDraft.value = issue.value.title;
  editingTitle.value = true;
}
async function saveTitle() {
  editingTitle.value = false;
  if (titleDraft.value.trim() && titleDraft.value !== issue.value.title) await update({ title: titleDraft.value });
}
function startDesc() {
  descDraft.value = issue.value.description || '';
  editingDesc.value = true;
}
async function saveDesc() {
  await update({ description: descDraft.value });
  editingDesc.value = false;
}
async function addComment() {
  if (!comment.value.trim()) return;
  await attempt(
    () => post(`/api/issues/${issue.value.key}/comments`, { body: comment.value, internal: internalNote.value && !isGuest.value }),
    {
      then: async () => {
        comment.value = '';
        internalNote.value = false;
        await load();
        changed();
      },
    },
  );
}
async function toggleWatch() {
  const path = `/api/issues/${issue.value.key}/watch`;
  await attempt(() => (issue.value.watching ? del(path) : post(path)), { then: load });
}
async function remove() {
  const subs = issue.value.children.filter((c) => c.type === 'subtask').length;
  if (
    !confirm(
      `Delete ${issue.value.key}${subs ? ` and its ${subs} sub-tasks` : ''}? It goes to the Trash, where it can be restored until it is removed for good.`,
    )
  )
    return;
  const { key, projectKey } = issue.value;
  await attempt(() => del(`/api/issues/${key}`), {
    ok: `${key} moved to the Trash`,
    then: () => {
      changed();
      emit('deleted');
      if (!props.panel) router.push(`/projects/${projectKey}/board`);
    },
  });
}
const copyLink = () => copyText(`${location.origin}/browse/${issue.value.key}`, { ok: 'Link copied' });
// Shortcuts while an issue is open: a = assign to me, w = watch, e = edit description.
function onKeys(e) {
  const tag = (e.target.tagName || '').toLowerCase();
  if (!issue.value || ['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable || e.metaKey || e.ctrlKey || e.altKey)
    return;
  if (document.querySelector('[role=dialog]')) return;
  if (e.key === 'a' && canEdit.value && issue.value.assignee?.id !== session.user.id) {
    e.preventDefault();
    update({ assigneeId: session.user.id });
    toast(`${issue.value.key} assigned to you`);
  } else if (e.key === 'w') {
    e.preventDefault();
    toggleWatch();
  } else if (e.key === 'e' && canEdit.value && !editingDesc.value) {
    e.preventDefault();
    startDesc();
  }
}
onMounted(() => window.addEventListener('keydown', onKeys));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeys));

// 3. Tick a checklist item in the description without opening the editor.
async function toggleTask(index, checked) {
  let n = -1;
  const next = (issue.value.description || '').replace(/^(\s*(?:[-*+]|\d+[.)])\s+\[)( |x|X)(\])/gm, (m, a, mark, b) => {
    n++;
    return n === index ? `${a}${checked ? 'x' : ' '}${b}` : m;
  });
  if (next !== issue.value.description) await update({ description: next });
}
</script>

<template>
  <div v-if="notFound" class="py-16 text-center text-slate-600">{{ notFound }}</div>
  <div
    v-else-if="issue"
    class="grid gap-6 rounded-md"
    :class="[
      panel ? 'md:grid-cols-[1fr_270px]' : 'lg:grid-cols-[1fr_320px]',
      dragging && 'outline-2 outline-dashed outline-offset-4 outline-blue-500',
    ]"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div class="min-w-0">
      <div class="mb-2 flex flex-wrap items-center gap-1.5 text-sm text-slate-500">
        <RouterLink :to="`/projects/${issue.projectKey}/board`" class="link">{{ issue.projectName }}</RouterLink>
        <template v-if="issue.parent"
          ><span>/</span><TypeIcon :type="issue.parent.type" :size="14" /><RouterLink :to="`/browse/${issue.parent.key}`" class="link">{{
            issue.parent.key
          }}</RouterLink></template
        >
        <span>/</span><TypeIcon :type="issue.type" :size="14" /><RouterLink
          :to="`/browse/${issue.key}`"
          class="font-medium text-slate-700 hover:underline"
          >{{ issue.key }}</RouterLink
        >
        <div class="ml-auto flex flex-wrap items-center justify-end gap-1">
          <template v-if="canEdit">
            <button v-if="timerState.timer?.issueKey === issue.key" class="btn btn-sm" :disabled="timerState.busy" @click="askStop">
              Stop timer
            </button>
            <button
              v-else
              class="btn btn-sm btn-ghost"
              :disabled="timerState.busy"
              :title="
                timerState.timer
                  ? `Stops the timer on ${timerState.timer.issueKey} and logs its time`
                  : 'Track the time you work on this issue'
              "
              @click="startTimer(issue.key)"
            >
              Start timer
            </button>
          </template>
          <button v-if="issue.canWatch || issue.watching" class="btn btn-sm btn-ghost" @click="toggleWatch">
            {{ issue.watching ? 'Watching' : 'Watch' }} ({{ issue.watchers.length }})
          </button>
          <button class="btn btn-sm btn-ghost" @click="copyLink">Copy link</button>
          <button v-if="issue.canDelete" class="btn btn-sm btn-ghost text-red-700" @click="remove">Delete</button>
          <button v-if="panel" class="btn btn-sm btn-ghost" aria-label="Close" @click="emit('close')">✕</button>
        </div>
      </div>
      <input
        v-if="editingTitle"
        v-model="titleDraft"
        aria-label="Title"
        class="input mb-3 text-xl font-semibold"
        maxlength="255"
        autofocus
        @keydown.enter="saveTitle"
        @keydown.esc="editingTitle = false"
        @blur="saveTitle"
      />
      <h1
        v-else
        class="mb-1 rounded px-1 -mx-1 text-xl font-semibold"
        :class="canEdit ? 'cursor-text hover:bg-slate-100' : ''"
        @click="startTitle"
      >
        {{ issue.title }}
      </h1>
      <div v-if="issue.blocked || issue.recurring" class="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <template v-if="issue.blocked">
          <span class="chip gap-1 bg-red-100 text-red-800"><Icon name="block" :size="12" />Blocked</span>
          <span class="text-slate-600"
            >by
            <template v-for="(k, n) in issue.blockedBy" :key="k"
              ><RouterLink :to="`/browse/${k}`" class="link">{{ k }}</RouterLink
              ><template v-if="n < issue.blockedBy.length - 1">, </template></template
            >
            <template v-if="issue.blockedHidden"
              >{{ issue.blockedBy.length ? ' and ' : '' }}{{ issue.blockedHidden === 1 ? 'an issue' : `${issue.blockedHidden} issues` }} you
              cannot see</template
            >
          </span>
        </template>
        <RouterLink
          v-if="issue.recurring"
          :to="`/projects/${issue.projectKey}/recurring?rule=${issue.recurring.id}`"
          class="chip gap-1 bg-slate-100 text-slate-700 hover:bg-slate-200"
          :title="`Created by the recurring rule ${issue.recurring.name}`"
          ><Icon name="repeat" :size="12" />Recurring</RouterLink
        >
      </div>
      <div class="mb-4 flex flex-wrap gap-x-5 gap-y-1 text-sm text-slate-600">
        <span class="flex items-center gap-1.5"
          >Assignee <Avatar :user="issue.assignee" :size="22" label="full" class="font-medium text-slate-800"
        /></span>
        <span class="flex items-center gap-1.5"
          >Reporter <Avatar :user="issue.reporter" :size="22" label="full" class="font-medium text-slate-800"
        /></span>
      </div>
      <div v-if="canEdit && project" class="mb-4" :class="panel ? 'md:hidden' : 'lg:hidden'">
        <StatusSelect :issue="issue" :project="project" class="input w-auto font-semibold" @changed="saved" />
      </div>

      <section class="mb-5">
        <h2 class="mb-1 text-sm font-semibold text-slate-700">Description</h2>
        <div v-if="editingDesc">
          <MarkdownEditor v-model="descDraft" :rows="8" autofocus :issue-key="issue.key" @submit="saveDesc" @uploaded="load" />
          <div class="mt-2 flex gap-2">
            <button class="btn btn-primary btn-sm" @click="saveDesc">Save</button
            ><button class="btn btn-sm" @click="editingDesc = false">Cancel</button>
          </div>
        </div>
        <div v-else class="rounded px-1 -mx-1" :class="canEdit ? 'cursor-text hover:bg-slate-50' : ''" @click="canEdit && startDesc()">
          <Markdown v-if="issue.description" :text="issue.description" :tasks="canEdit" @toggle-task="toggleTask" />
          <p v-else class="text-sm text-slate-400">{{ canEdit ? 'Add a description' : 'No description' }}</p>
        </div>
      </section>

      <IssueChildren v-if="!isSub" :issue="issue" :can-create="Boolean(canEdit && project?.canCreate)" @changed="reloadAll" />

      <IssueDependencies v-if="issue.type === 'epic' && issue.children.length" :issue="issue" />

      <IssueLinks :issue="issue" :can-edit="canEdit" @changed="load" />

      <IssueRaid v-if="!isGuest" :issue-key="issue.key" />

      <IssueAttachments
        ref="attachmentsRef"
        :issue-key="issue.key"
        :attachments="issue.attachments || []"
        :can-edit="canEdit"
        :can-admin="!!project?.canAdmin"
        :guest="isGuest"
        @changed="reloadAll"
      />

      <IssueChannels v-if="!isGuest" :issue-key="issue.key" @changed="reloadAll" />

      <section>
        <div class="mb-3 flex gap-1 border-b border-slate-200">
          <button
            v-for="t in [
              ['comments', `Comments (${commentCount})`],
              ['history', 'History'],
              ['work', `Work log (${issue.loggedHours}h)`],
            ]"
            :key="t[0]"
            class="px-3 py-1.5 text-sm"
            :class="tab === t[0] ? 'border-b-2 border-blue-700 font-semibold text-blue-800' : 'text-slate-600'"
            @click="tab = t[0]"
          >
            {{ t[1] }}
          </button>
        </div>
        <div v-if="tab === 'comments'" class="space-y-4">
          <div v-if="canComment" class="flex gap-2">
            <Avatar :user="session.user" :size="28" />
            <div class="min-w-0 flex-1">
              <MarkdownEditor
                v-model="comment"
                :rows="3"
                :placeholder="internalNote ? 'Internal note: only team members see it' : 'Add a comment or a status update'"
                :issue-key="issue.key"
                :internal="internalNote"
                @submit="addComment"
                @uploaded="load"
              />
              <div class="mt-2 flex flex-wrap items-center gap-3">
                <button class="btn btn-primary btn-sm" :disabled="!comment.trim()" @click="addComment">
                  {{ internalNote ? 'Add internal note' : 'Comment' }}
                </button>
                <label
                  v-if="!isGuest"
                  class="flex items-center gap-1.5 text-xs text-slate-600"
                  title="Guests (clients) never see internal notes or their files"
                  ><input v-model="internalNote" type="checkbox" />Internal note</label
                >
              </div>
            </div>
          </div>
          <p v-else-if="issue.guest && issue.canWatch" class="text-xs text-slate-500">Only team members can comment in this project.</p>
          <CommentThread
            v-for="t in threads"
            :key="t.id"
            :thread="t.comment"
            :replies="t.replies"
            :issue-key="issue.key"
            :can-comment="canComment"
            :can-admin="Boolean(project?.canAdmin)"
            @changed="load"
          />
        </div>
        <IssueHistory v-if="tab === 'history'" :history="issue.history" />
        <IssueWorklog v-if="tab === 'work'" :issue="issue" :can-edit="canEdit" :can-admin="Boolean(project?.canAdmin)" @changed="load" />
      </section>
    </div>

    <aside class="min-w-0 space-y-4">
      <div>
        <StatusSelect v-if="canEdit && project" :issue="issue" :project="project" class="input w-auto font-semibold" @changed="saved" />
        <StatusBadge v-else :status="issue.status" />
      </div>
      <div class="card divide-y divide-slate-100 text-sm">
        <FieldRow label="Assignee">
          <UserSelect
            v-if="canEdit"
            compact
            :model-value="issue.assignee?.id || null"
            @update:model-value="update({ assigneeId: $event })"
          />
          <span v-else class="flex items-center gap-2"
            ><Avatar :user="issue.assignee" :size="22" />{{ issue.assignee?.name || 'Unassigned' }}</span
          >
        </FieldRow>
        <FieldRow label="Reporter">
          <UserSelect
            v-if="canEdit && !isGuest"
            compact
            :allow-none="false"
            :model-value="issue.reporter?.id || null"
            @update:model-value="update({ reporterId: $event })"
          />
          <span v-else>{{ issue.reporter?.name }}</span>
        </FieldRow>
        <FieldRow label="Type">
          <select
            v-if="canEdit && !isSub"
            :value="issue.type"
            class="input py-1"
            aria-label="Type"
            @change="update({ type: $event.target.value })"
          >
            <option v-for="t in TYPES.filter((t) => t.id !== 'subtask')" :key="t.id" :value="t.id">{{ t.label }}</option>
          </select>
          <span v-else>{{ typeOf(issue.type).label }}</span>
        </FieldRow>
        <FieldRow label="Priority">
          <select
            :value="issue.priority"
            class="input py-1"
            aria-label="Priority"
            :disabled="!canEdit"
            @change="update({ priority: $event.target.value })"
          >
            <option v-for="p in PRIORITIES" :key="p.id" :value="p.id">{{ p.arrow }} {{ p.label }}</option>
          </select>
        </FieldRow>
        <FieldRow v-if="issue.type !== 'epic' && !isSub" label="Epic">
          <select
            :value="issue.parent?.key || ''"
            class="input py-1"
            aria-label="Epic"
            :disabled="!canEdit"
            @change="update({ parentKey: $event.target.value || null })"
          >
            <option value="">None</option>
            <option v-for="e in epics" :key="e.key" :value="e.key">{{ e.key }} {{ e.title }}</option>
          </select>
        </FieldRow>
        <FieldRow v-if="project" label="Sprint">
          <select
            :value="issue.sprint?.id || ''"
            class="input py-1"
            aria-label="Sprint"
            :disabled="!canEdit || !issue.canSprints"
            :title="canEdit ? sprintReason : ''"
            @change="update({ sprintId: $event.target.value || null })"
          >
            <option value="">Backlog</option>
            <option v-if="issue.sprint && !project.sprints.some((s) => s.id === issue.sprint.id)" :value="issue.sprint.id">
              {{ issue.sprint.name }} (closed)
            </option>
            <option v-for="s in project.sprints" :key="s.id" :value="s.id">
              {{ s.name }}{{ s.state === 'active' ? ' (active)' : '' }}
            </option>
          </select>
        </FieldRow>
        <FieldRow label="Labels">
          <LabelsInput v-if="canEdit" :model-value="issue.labels" @update:model-value="update({ labels: $event })" />
          <span v-else>{{ issue.labels.join(', ') || 'None' }}</span>
        </FieldRow>
        <FieldRow v-if="project?.components?.length || issue.components?.length" label="Components">
          <MultiPick
            :model-value="(issue.components || []).map((x) => x.id)"
            :options="componentOptions(project)"
            :known="issue.components || []"
            label="Components"
            :disabled="!canEdit"
            @update:model-value="update({ components: $event })"
          />
        </FieldRow>
        <FieldRow v-if="project?.releases?.length || issue.fixVersions?.length" label="Fix versions">
          <MultiPick
            :model-value="(issue.fixVersions || []).map((x) => x.id)"
            :options="versionOptions(project)"
            :known="issue.fixVersions || []"
            label="Fix versions"
            :disabled="!canEdit"
            @update:model-value="update({ fixVersions: $event })"
          />
        </FieldRow>
        <FieldRow label="Story points">
          <input
            :value="issue.storyPoints ?? ''"
            type="number"
            min="0"
            step="0.5"
            class="input py-1"
            :disabled="!canEdit"
            aria-label="Story points"
            @change="update({ storyPoints: $event.target.value === '' ? null : Number($event.target.value) })"
          />
        </FieldRow>
        <FieldRow label="Estimate (h)">
          <input
            :value="issue.estimateHours ?? ''"
            type="number"
            min="0"
            step="0.5"
            class="input py-1"
            :disabled="!canEdit"
            aria-label="Estimate (hours)"
            @change="update({ estimateHours: $event.target.value === '' ? null : Number($event.target.value) })"
          />
        </FieldRow>
        <FieldRow label="Due date">
          <input
            :value="issue.dueDate || ''"
            type="date"
            class="input py-1"
            :disabled="!canEdit"
            aria-label="Due date"
            @change="update({ dueDate: $event.target.value || null })"
          />
        </FieldRow>
        <FieldRow label="Start date">
          <input
            :value="issue.startDate || ''"
            type="date"
            class="input py-1"
            :disabled="!canEdit"
            :max="issue.dueDate || undefined"
            aria-label="Start date"
            @change="update({ startDate: $event.target.value || null })"
          />
        </FieldRow>
        <IssueFields v-if="project?.fields?.length" :issue="issue" :fields="project.fields" :can-edit="canEdit" @update="update" />
        <FieldRow label="Watchers" top>
          <IssueWatchers :issue="issue" :can-edit="canEdit" :can-add="canEdit && !isGuest" @changed="load" />
        </FieldRow>
      </div>
      <div class="space-y-1 px-1 text-xs text-slate-500">
        <div>Created {{ fmtDateTime(issue.createdAt) }}</div>
        <div>Updated {{ ago(issue.updatedAt) }}</div>
        <div v-if="issue.resolvedAt">Resolved {{ fmtDateTime(issue.resolvedAt) }}</div>
      </div>
      <button
        v-if="canEdit && project?.canCreate && !isSub && issue.type !== 'epic'"
        class="btn btn-sm w-full"
        @click="openCreate({ projectKey: issue.projectKey, type: 'subtask', parentKey: issue.key, stay: true })"
      >
        Create sub-task with details
      </button>
    </aside>
  </div>
  <div v-else class="space-y-4 py-2">
    <div class="h-6 w-2/3 animate-pulse rounded-full bg-slate-200"></div>
    <Skeleton :rows="6" />
  </div>
</template>
