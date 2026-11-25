<script setup>
// Asks for the values a workflow rule needs before an issue can enter a status (src/workflow.js withWorkflow).
import { reactive, computed, ref, watch } from 'vue';
import { transition } from '../workflow.js';
import { versionOptions, componentOptions } from '../releases.js';
import Modal from './Modal.vue';
import UserSelect from './UserSelect.vue';
import MultiPick from './MultiPick.vue';
import FieldInput from './FieldInput.vue';

const v = reactive({
  assigneeId: null,
  storyPoints: '',
  estimateHours: '',
  dueDate: '',
  fixVersions: [],
  components: [],
  comment: '',
  fields: {},
});
const error = ref('');
const blank = () => ({
  assigneeId: null,
  storyPoints: '',
  estimateHours: '',
  dueDate: '',
  fixVersions: [],
  components: [],
  comment: '',
  fields: {},
});
watch(
  () => transition.open,
  (open) => {
    if (open) {
      Object.assign(v, blank());
      error.value = '';
    }
  },
);
const fieldOf = (m) =>
  (transition.project?.fields || []).find((f) => f.id === m.fieldId) || {
    id: m.fieldId,
    name: m.label,
    type: m.type || 'text',
    options: [],
  };
const items = computed(() => transition.missing);

function close(values) {
  const resolve = transition.resolve;
  Object.assign(transition, { open: false, project: null, status: null, missing: [], resolve: null });
  resolve?.(values);
}
const empty = (x) => x === null || x === undefined || x === '' || (Array.isArray(x) && !x.length);
function submit() {
  const out = {};
  const left = [];
  for (const m of items.value) {
    if (m.key === 'assignee') out.assigneeId = v.assigneeId;
    else if (m.key === 'storyPoints') out.storyPoints = v.storyPoints === '' ? null : Number(v.storyPoints);
    else if (m.key === 'estimate') out.estimateHours = v.estimateHours === '' ? null : Number(v.estimateHours);
    else if (m.key === 'dueDate') out.dueDate = v.dueDate || null;
    else if (m.key === 'fixVersion') out.fixVersions = v.fixVersions;
    else if (m.key === 'components') out.components = v.components;
    else if (m.key === 'comment') out.comment = v.comment.trim();
    else if (m.fieldId) out.fields = { ...(out.fields || {}), [m.fieldId]: v.fields[m.fieldId] ?? null };
    const val =
      m.key === 'assignee'
        ? out.assigneeId
        : m.key === 'storyPoints'
          ? out.storyPoints
          : m.key === 'estimate'
            ? out.estimateHours
            : m.key === 'dueDate'
              ? out.dueDate
              : m.key === 'fixVersion'
                ? out.fixVersions
                : m.key === 'components'
                  ? out.components
                  : m.key === 'comment'
                    ? out.comment
                    : out.fields?.[m.fieldId];
    if (empty(val)) left.push(m.label);
  }
  if (left.length) {
    error.value = `Fill in: ${left.join(', ')}`;
    return;
  }
  close(out);
}
</script>

<template>
  <Modal v-if="transition.open" :title="`Move to ${transition.status?.name || 'the new status'}`" @close="close(null)">
    <form id="transition-form" class="space-y-3" @submit.prevent="submit">
      <p class="text-sm text-slate-600">This project needs these values before an issue can move to {{ transition.status?.name }}.</p>
      <div v-for="m in items" :key="m.key">
        <template v-if="m.key === 'assignee'"
          ><span class="label">Assignee</span><UserSelect v-model="v.assigneeId" :allow-none="false" placeholder="Choose a person"
        /></template>
        <template v-else-if="m.key === 'storyPoints'"
          ><label class="label" for="tr-sp">Story points</label
          ><input id="tr-sp" v-model="v.storyPoints" type="number" min="0" step="any" class="input"
        /></template>
        <template v-else-if="m.key === 'estimate'"
          ><label class="label" for="tr-est">Estimate (hours)</label
          ><input id="tr-est" v-model="v.estimateHours" type="number" min="0" step="any" class="input"
        /></template>
        <template v-else-if="m.key === 'dueDate'"
          ><label class="label" for="tr-due">Due date</label><input id="tr-due" v-model="v.dueDate" type="date" class="input"
        /></template>
        <template v-else-if="m.key === 'fixVersion'"
          ><span class="label">Fix version</span
          ><MultiPick
            v-model="v.fixVersions"
            :options="versionOptions(transition.project)"
            label="Fix version"
            placeholder="Add a fix version"
        /></template>
        <template v-else-if="m.key === 'components'"
          ><span class="label">Components</span
          ><MultiPick
            v-model="v.components"
            :options="componentOptions(transition.project)"
            label="Components"
            placeholder="Add a component"
        /></template>
        <template v-else-if="m.key === 'comment'"
          ><label class="label" for="tr-comment">Resolution comment</label
          ><textarea id="tr-comment" v-model="v.comment" class="input" rows="3" maxlength="20000" placeholder="What was done"></textarea>
        </template>
        <template v-else-if="m.fieldId"
          ><label class="label" :for="'tr-' + m.fieldId">{{ m.label }}</label
          ><FieldInput :id="'tr-' + m.fieldId" v-model="v.fields[m.fieldId]" :field="fieldOf(m)"
        /></template>
      </div>
      <p v-if="error" class="text-sm text-red-700" role="alert">{{ error }}</p>
    </form>
    <template #footer>
      <button type="button" class="btn" @click="close(null)">Cancel</button>
      <button type="submit" form="transition-form" class="btn btn-primary">Move</button>
    </template>
  </Modal>
</template>
