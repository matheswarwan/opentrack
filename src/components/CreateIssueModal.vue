<script setup>
import { ref, reactive, onMounted, watch, computed } from 'vue';
import { useRouter } from 'vue-router';
import { get, post, toast, session } from '../api.js';
import { ui, changed } from '../ui.js';
import { TYPES, PRIORITIES } from '../meta.js';
import Modal from './Modal.vue';
import UserSelect from './UserSelect.vue';
import LabelsInput from './LabelsInput.vue';
import MarkdownEditor from './MarkdownEditor.vue';
import AiEnhance from './AiEnhance.vue';
import SlackImport from './SlackImport.vue';
import AttachFiles from './AttachFiles.vue';
import TemplateSelect from './TemplateSelect.vue';
import FieldInput from './FieldInput.vue';
import { activeFields, appliesTo } from '../fields.js';
import MultiPick from './MultiPick.vue';
import { versionOptions, componentOptions } from '../releases.js';
import { projectList, project as fetchProject } from '../projects.js';
import { attempt } from '../composables/useAction.js';

const router = useRouter();
const projects = ref([]);
const project = ref(null);
const epics = ref([]);
const busy = ref(false);
const error = ref('');
const another = ref(false);
const attach = ref(null);
const tpl = ref(null); // template picker: adds the template's sub-tasks after create
const d = ui.create;
const form = reactive({
  projectKey: d.projectKey || '',
  type: d.type || 'task',
  title: d.title || '',
  description: d.description || '',
  priority: 'medium',
  assigneeId: null,
  labels: [],
  parentKey: d.parentKey || '',
  sprintId: d.sprintId || '',
  statusId: d.statusId || '',
  storyPoints: '',
  dueDate: d.dueDate || '', // the calendar's + on a day
  fields: {}, // custom fields: id -> API value
  components: [], // component ids
  fixVersions: [], // release ids
});
// custom fields of the chosen project that apply to the chosen type
const createFields = computed(() => activeFields(project.value?.fields).filter((f) => appliesTo(f, form.type)));
function applyTemplate(t) {
  const { fields, components, ...rest } = t;
  Object.assign(form, rest);
  if (fields) form.fields = { ...form.fields, ...fields };
  if (components)
    form.components = [...new Set([...form.components, ...components.filter((id) => project.value?.components?.some((c) => c.id === id))])];
}
function fieldValues() {
  const out = {};
  for (const f of createFields.value) {
    const v = form.fields[f.id];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    out[f.id] = v;
  }
  return out;
}

onMounted(() =>
  attempt(async () => {
    projects.value = (await projectList()).filter((p) => p.canCreate); // the project's create permission (and guest editors)
    if (!form.projectKey || !projects.value.some((p) => p.key === form.projectKey)) form.projectKey = projects.value[0]?.key || '';
  }),
);
watch(
  () => form.projectKey,
  (key) =>
    key &&
    attempt(async () => {
      project.value = await fetchProject(key);
      form.fields = {};
      form.components = [];
      form.fixVersions = [];
      epics.value = (await get(`/api/issues?project=${key}&type=epic&category=todo,in_progress&limit=200&sort=key`)).issues;
      if (form.statusId && !project.value.statuses.some((s) => s.id === form.statusId)) form.statusId = '';
    }),
  { immediate: true },
);
const isSub = computed(() => form.type === 'subtask');

function applyAi(r) {
  form.title = r.title;
  form.description = r.description;
  if (r.type && r.type !== 'subtask' && form.type !== 'subtask') form.type = r.type;
  if (r.priority) form.priority = r.priority;
  form.labels = [...new Set([...form.labels, ...r.labels])];
}

async function submit() {
  error.value = '';
  busy.value = true;
  try {
    const r = await post('/api/issues', {
      ...form,
      parentKey: form.type === 'epic' ? null : form.parentKey || null,
      sprintId: form.sprintId || null,
      statusId: form.statusId || null,
      storyPoints: form.storyPoints === '' ? null : Number(form.storyPoints),
      dueDate: form.dueDate || null,
      fields: fieldValues(),
    });
    await attach.value?.uploadTo(r.issue.key);
    await tpl.value?.afterCreate(r.issue);
    ui.lastProjectKey = form.projectKey;
    changed();
    toast(`Created ${r.issue.key}`);
    if (another.value) {
      form.title = '';
      form.description = '';
    } else {
      ui.create = null;
      if (!d.stay) router.push(`/browse/${r.issue.key}`);
    }
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Modal title="Create issue" wide @close="ui.create = null">
    <form id="create-issue" class="grid grid-cols-2 gap-3" @submit.prevent="submit">
      <SlackImport v-if="session.user?.role !== 'guest'" class="col-span-2" @import="(m) => Object.assign(form, m)" />
      <div>
        <label class="label" for="ci-project">Project</label>
        <select id="ci-project" v-model="form.projectKey" class="input" required>
          <option v-for="p in projects" :key="p.key" :value="p.key">{{ p.name }} ({{ p.key }})</option>
        </select>
        <p v-if="!projects.length" class="mt-1 text-xs text-slate-500">No projects you can add issues to yet.</p>
      </div>
      <div>
        <label class="label" for="ci-type">Type</label>
        <select id="ci-type" v-model="form.type" class="input">
          <option v-for="t in TYPES" :key="t.id" :value="t.id">{{ t.label }}</option>
        </select>
      </div>
      <TemplateSelect
        ref="tpl"
        class="col-span-2"
        :project-key="form.projectKey"
        :title="form.title"
        :description="form.description"
        :labels="form.labels"
        @apply="applyTemplate"
      />
      <div class="col-span-2">
        <label class="label" for="ci-title">Summary</label>
        <input id="ci-title" v-model="form.title" class="input" maxlength="255" required autofocus />
      </div>
      <div class="col-span-2">
        <label class="label">Description</label>
        <MarkdownEditor v-model="form.description" :rows="5" />
        <AiEnhance
          class="mt-2"
          :title="form.title"
          :description="form.description"
          :type="form.type"
          :project-name="project?.name"
          @apply="applyAi"
        />
        <AttachFiles ref="attach" class="mt-2" />
      </div>
      <div>
        <label class="label">Assignee</label>
        <UserSelect v-model="form.assigneeId" />
      </div>
      <div>
        <label class="label" for="ci-priority">Priority</label>
        <select id="ci-priority" v-model="form.priority" class="input">
          <option v-for="p in PRIORITIES" :key="p.id" :value="p.id">{{ p.label }}</option>
        </select>
      </div>
      <div v-if="form.type !== 'epic'">
        <label class="label" for="ci-parent">{{ isSub ? 'Parent issue (key)' : 'Epic' }}</label>
        <input v-if="isSub" id="ci-parent" v-model="form.parentKey" class="input" placeholder="e.g. WEB-12" required />
        <select v-else id="ci-parent" v-model="form.parentKey" class="input">
          <option value="">None</option>
          <option v-for="e in epics" :key="e.key" :value="e.key">{{ e.key }} {{ e.title }}</option>
        </select>
      </div>
      <div v-if="project && project.canSprints">
        <label class="label" for="ci-sprint">Sprint</label>
        <select id="ci-sprint" v-model="form.sprintId" class="input">
          <option value="">Backlog</option>
          <option v-for="s in project.sprints" :key="s.id" :value="s.id">{{ s.name }}{{ s.state === 'active' ? ' (active)' : '' }}</option>
        </select>
      </div>
      <div v-if="project">
        <label class="label" for="ci-status">Status</label>
        <select id="ci-status" v-model="form.statusId" class="input">
          <option value="">{{ project.statuses[0]?.name }} (default)</option>
          <option v-for="s in project.statuses.slice(1)" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select>
      </div>
      <div>
        <label class="label">Labels</label>
        <LabelsInput v-model="form.labels" />
      </div>
      <div v-if="project?.components?.length">
        <span class="label">Components</span>
        <MultiPick v-model="form.components" :options="componentOptions(project)" label="Components" placeholder="Add component" />
      </div>
      <div v-if="versionOptions(project).length">
        <span class="label">Fix versions</span>
        <MultiPick v-model="form.fixVersions" :options="versionOptions(project)" label="Fix versions" placeholder="Add fix version" />
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="label" for="ci-points">Story points</label
          ><input id="ci-points" v-model="form.storyPoints" type="number" min="0" step="0.5" class="input" />
        </div>
        <div><label class="label" for="ci-due">Due date</label><input id="ci-due" v-model="form.dueDate" type="date" class="input" /></div>
        <div>
          <label class="label" for="ci-start">Start date</label><input id="ci-start" v-model="form.startDate" type="date" class="input" />
        </div>
      </div>
      <div v-for="cf in createFields" :key="cf.id" :class="cf.type === 'longtext' || cf.type === 'multiselect' ? 'col-span-2' : ''">
        <label class="label" :for="'ci-cf-' + cf.id">{{ cf.name }}<span v-if="cf.required"> (required)</span></label>
        <FieldInput :id="'ci-cf-' + cf.id" v-model="form.fields[cf.id]" :field="cf" />
        <p v-if="cf.help" class="mt-1 text-xs text-slate-500">{{ cf.help }}</p>
      </div>
      <p v-if="error" class="col-span-2 text-sm text-red-700">{{ error }}</p>
    </form>
    <template #footer>
      <label class="mr-auto flex items-center gap-2 text-sm text-slate-600"
        ><input v-model="another" type="checkbox" /> Create another</label
      >
      <button class="btn" @click="ui.create = null">Cancel</button>
      <button class="btn btn-primary" form="create-issue" type="submit" :disabled="busy || !form.projectKey">Create</button>
    </template>
  </Modal>
</template>
