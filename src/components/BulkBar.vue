<script setup>
// Action bar for the selected issues on the Issues page. selected: [{ key, projectKey }].
import { ref, computed, watch } from 'vue';
import { post, toast } from '../api.js';
import { PRIORITIES } from '../meta.js';
import UserSelect from './UserSelect.vue';
import LabelsInput from './LabelsInput.vue';
import FieldInput from './FieldInput.vue';
import { activeFields } from '../fields.js';
import MultiPick from './MultiPick.vue';
import { versionOptions, componentOptions } from '../releases.js';
import { project as fetchProject } from '../projects.js';
import { plural } from '../plural.js';

const props = defineProps({ selected: { type: Array, required: true } });
const emit = defineEmits(['done', 'clear']);
// The API takes up to 500 keys per call; D1 also caps the queries per request, so send smaller parts.
const PART = 25;
const QUIET_OVER = 20;

const busy = ref(false);
const panel = ref(null); // 'addLabels' | 'removeLabels' | 'due' | 'delete'
const labels = ref([]);
const due = ref('');
const start = ref(''); // Roadmap start date
const confirmText = ref('');
const last = ref(null); // last result: { verb, updated, skipped, errors }
const showErrors = ref(false);

const n = computed(() => props.selected.length);
const projectKeys = computed(() => [...new Set(props.selected.map((s) => s.projectKey))]);
const oneProject = computed(() => (projectKeys.value.length === 1 ? projectKeys.value[0] : null));
const project = ref(null);
watch(
  oneProject,
  async (k) => {
    project.value = null;
    if (!k) return;
    try {
      const p = await fetchProject(k);
      if (oneProject.value === k) project.value = p;
    } catch {
      /* no access */
    }
  },
  { immediate: true },
);
const whyNoProject = 'Statuses and sprints belong to a project. Select issues from one project to change them.';
const deleteWord = computed(() => `delete ${n.value} ${plural(n.value, 'issue')}`);

async function run(payload, verb) {
  busy.value = true;
  showErrors.value = false;
  const keys = props.selected.map((s) => s.key);
  const results = [];
  try {
    for (let i = 0; i < keys.length; i += PART) {
      const r = await post('/api/issues/bulk', { ...payload, keys: keys.slice(i, i + PART), quiet: keys.length > QUIET_OVER });
      results.push(...r.results);
    }
  } catch (e) {
    toast(e.message, 'error');
    if (!results.length) {
      busy.value = false;
      return;
    }
  }
  const errors = results.filter((r) => !r.ok);
  const updated = results.length - errors.length;
  last.value = { verb, updated, skipped: errors.length, errors };
  toast(
    `${verb} ${updated} ${plural(updated, 'issue')}${errors.length ? `; ${errors.length} skipped` : ''}`,
    errors.length && !updated ? 'error' : 'ok',
  );
  panel.value = null;
  labels.value = [];
  confirmText.value = '';
  busy.value = false;
  emit('done', { results, deleted: payload.action === 'delete' });
}
const change = (changes) => run({ changes }, 'Updated');
function onSelect(e, make) {
  const v = e.target.value;
  e.target.value = '';
  if (v !== '') change(make(v));
}
const toggle = (p) => {
  panel.value = panel.value === p ? null : p;
  labels.value = [];
  confirmText.value = '';
};
// custom fields (one project selected): set or clear one field on every selected issue
const projectFields = computed(() => activeFields(project.value?.fields));
const fieldId = ref('');
const fieldValue = ref(null);
const pickedField = computed(() => projectFields.value.find((f) => f.id === fieldId.value) || null);
watch(fieldId, () => {
  fieldValue.value = null;
});
const hasFieldValue = computed(
  () => fieldValue.value !== null && fieldValue.value !== '' && !(Array.isArray(fieldValue.value) && !fieldValue.value.length),
);
const setField = (v) => pickedField.value && change({ fields: { [pickedField.value.id]: v } });
// components and fix versions (one project selected): add or remove them on every selected issue
const relPicks = ref([]);
watch(panel, () => {
  relPicks.value = [];
});
const relOptions = computed(() => (panel.value === 'components' ? componentOptions(project.value) : versionOptions(project.value)));
const relEdit = (verb) => change({ [`${verb}${panel.value === 'components' ? 'Components' : 'FixVersions'}`]: relPicks.value });
</script>

<template>
  <div
    class="sticky top-0 z-30 mb-3 rounded-[15px] border border-slate-300 bg-white p-2 text-sm shadow-md"
    role="region"
    aria-label="Bulk actions"
  >
    <div class="flex flex-wrap items-center gap-2">
      <strong class="whitespace-nowrap">{{ n }} selected</strong>
      <!-- Not a StatusSelect: the selected issues have different statuses, so no move can be ruled out up front. The server checks
           the workflow rules for each issue; refused ones are listed as skipped, and nothing asks for missing values here. -->
      <select
        class="input w-auto py-1"
        :disabled="busy || !project"
        :title="oneProject ? '' : whyNoProject"
        aria-label="Set status"
        @change="onSelect($event, (v) => ({ statusId: v }))"
      >
        <option value="">Status</option>
        <option v-for="s in project?.statuses || []" :key="s.id" :value="s.id">{{ s.name }}</option>
      </select>
      <div class="w-40">
        <UserSelect :model-value="null" button-label="Assignee" @update:model-value="change({ assigneeId: $event })" />
      </div>
      <select class="input w-auto py-1" :disabled="busy" aria-label="Set priority" @change="onSelect($event, (v) => ({ priority: v }))">
        <option value="">Priority</option>
        <option v-for="p in PRIORITIES" :key="p.id" :value="p.id">{{ p.arrow }} {{ p.label }}</option>
      </select>
      <select
        class="input w-auto py-1"
        :disabled="busy || !project"
        :title="oneProject ? '' : whyNoProject"
        aria-label="Set sprint"
        @change="onSelect($event, (v) => ({ sprintId: v === 'backlog' ? null : v }))"
      >
        <option value="">Sprint</option>
        <option value="backlog">Backlog (no sprint)</option>
        <option v-for="s in project?.sprints || []" :key="s.id" :value="s.id">
          {{ s.name }}{{ s.state === 'active' ? ' (active)' : '' }}
        </option>
      </select>
      <button class="btn btn-sm" :disabled="busy" @click="toggle('addLabels')">Add labels</button>
      <button class="btn btn-sm" :disabled="busy" @click="toggle('removeLabels')">Remove labels</button>
      <button class="btn btn-sm" :disabled="busy" @click="toggle('due')">Dates</button>
      <button v-if="projectFields.length" class="btn btn-sm" :disabled="busy" @click="toggle('field')">Field</button>
      <button v-if="project?.components?.length" class="btn btn-sm" :disabled="busy" @click="toggle('components')">Components</button>
      <button v-if="versionOptions(project).length" class="btn btn-sm" :disabled="busy" @click="toggle('fixVersions')">Fix versions</button>
      <button class="btn btn-sm" :disabled="busy" @click="run({ action: 'watch' }, 'Watching')">Watch</button>
      <button class="btn btn-sm" :disabled="busy" @click="run({ action: 'unwatch' }, 'Stopped watching')">Unwatch</button>
      <button class="btn btn-sm btn-danger" :disabled="busy" @click="toggle('delete')">Delete</button>
      <button class="btn btn-sm btn-ghost ml-auto" @click="emit('clear')">Clear selection</button>
    </div>
    <p v-if="!oneProject" class="mt-1 text-xs text-slate-500">
      Status and sprint are off: the selection spans {{ projectKeys.length }} projects. {{ whyNoProject }}
    </p>

    <form
      v-if="panel === 'addLabels' || panel === 'removeLabels'"
      class="mt-2 flex flex-wrap items-center gap-2"
      @submit.prevent="labels.length && change({ [panel]: labels })"
    >
      <div class="min-w-48 flex-1"><LabelsInput v-model="labels" /></div>
      <button class="btn btn-sm btn-primary" :disabled="busy || !labels.length">
        {{ panel === 'addLabels' ? 'Add' : 'Remove' }} on {{ n }} issues
      </button>
      <button type="button" class="btn btn-sm" @click="panel = null">Cancel</button>
    </form>
    <form v-if="panel === 'due'" class="mt-2 flex flex-wrap items-center gap-2" @submit.prevent="due && change({ dueDate: due })">
      <input v-model="due" type="date" class="input w-auto py-1" aria-label="Due date" />
      <button class="btn btn-sm btn-primary" :disabled="busy || !due">Set</button>
      <button type="button" class="btn btn-sm" :disabled="busy" @click="change({ dueDate: null })">Clear due date</button>
      <button type="button" class="btn btn-sm" @click="panel = null">Cancel</button>
    </form>
    <form v-if="panel === 'due'" class="mt-2 flex flex-wrap items-center gap-2" @submit.prevent="start && change({ startDate: start })">
      <input v-model="start" type="date" class="input w-auto py-1" aria-label="Start date" />
      <button class="btn btn-sm btn-primary" :disabled="busy || !start">Set start date</button>
      <button type="button" class="btn btn-sm" :disabled="busy" @click="change({ startDate: null })">Clear start date</button>
    </form>
    <form v-if="panel === 'field'" class="mt-2 flex flex-wrap items-center gap-2" @submit.prevent="hasFieldValue && setField(fieldValue)">
      <select v-model="fieldId" class="input w-auto py-1" aria-label="Field to set">
        <option value="">Choose a field</option>
        <option v-for="f in projectFields" :key="f.id" :value="f.id">{{ f.name }}</option>
      </select>
      <div v-if="pickedField" class="min-w-48 flex-1"><FieldInput v-model="fieldValue" compact :field="pickedField" /></div>
      <button class="btn btn-sm btn-primary" :disabled="busy || !hasFieldValue">Set on {{ n }} issues</button>
      <button v-if="pickedField" type="button" class="btn btn-sm" :disabled="busy" @click="setField(null)">
        Clear {{ pickedField.name }}
      </button>
      <button type="button" class="btn btn-sm" @click="panel = null">Cancel</button>
    </form>
    <form v-if="panel === 'components' || panel === 'fixVersions'" class="mt-2 flex flex-wrap items-center gap-2" @submit.prevent>
      <div class="min-w-48 flex-1">
        <MultiPick
          v-model="relPicks"
          :options="relOptions"
          :label="panel === 'components' ? 'Components' : 'Fix versions'"
          :placeholder="panel === 'components' ? 'Choose components' : 'Choose fix versions'"
        />
      </div>
      <button type="button" class="btn btn-sm btn-primary" :disabled="busy || !relPicks.length" @click="relEdit('add')">
        Add to {{ n }} issues
      </button>
      <button type="button" class="btn btn-sm" :disabled="busy || !relPicks.length" @click="relEdit('remove')">
        Remove from {{ n }} issues
      </button>
      <button type="button" class="btn btn-sm" @click="panel = null">Cancel</button>
    </form>
    <form
      v-if="panel === 'delete'"
      class="mt-2 rounded-md bg-red-50 p-2"
      @submit.prevent="confirmText.trim().toLowerCase() === deleteWord && run({ action: 'delete' }, 'Deleted')"
    >
      <p class="mb-1">
        This moves {{ n }} issues and their sub-tasks to the <RouterLink to="/trash" class="link">Trash</RouterLink>, where they can be
        restored until they are removed for good. You can delete issues you reported, or any issue in projects you admin. Type
        <strong>{{ deleteWord }}</strong> to confirm.
      </p>
      <div class="flex flex-wrap items-center gap-2">
        <input v-model="confirmText" class="input w-64 py-1" :placeholder="deleteWord" aria-label="Type the confirmation" autofocus />
        <button class="btn btn-sm btn-danger" :disabled="busy || confirmText.trim().toLowerCase() !== deleteWord">Delete</button>
        <button type="button" class="btn btn-sm" @click="panel = null">Cancel</button>
      </div>
    </form>

    <div v-if="busy" class="mt-1 text-xs text-slate-500">Working on {{ n }} issues...</div>
    <div v-else-if="last" class="relative mt-1 text-xs text-slate-600">
      {{ last.verb }} {{ last.updated }} {{ plural(last.updated, 'issue')
      }}<template v-if="last.skipped"
        >; {{ last.skipped }} skipped.
        <button class="link" :aria-expanded="showErrors" @click="showErrors = !showErrors">
          {{ showErrors ? 'Hide details' : 'Details' }}
        </button></template
      >
      <ul
        v-if="showErrors"
        class="absolute left-0 z-40 mt-1 max-h-64 w-full max-w-md overflow-y-auto rounded-md border border-slate-200 bg-white p-2 shadow-lg"
      >
        <li v-for="e in last.errors" :key="e.key" class="py-0.5">
          <strong>{{ e.key }}</strong>: {{ e.error }}
        </li>
      </ul>
    </div>
  </div>
</template>
