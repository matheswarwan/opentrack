<script setup>
// "Template" picker for the Create issue dialog. Shown only when the project has templates.
// Emits `apply` with the form fields to set; afterCreate(issue) adds the template's sub-tasks.
import { ref, watch } from 'vue';
import { get, post, toast } from '../api.js';

const props = defineProps({ projectKey: String, title: String, description: String, labels: { type: Array, default: () => [] } });
const emit = defineEmits(['apply']);
const templates = ref([]);
const chosenId = ref('');
let chosen = null;

watch(
  () => props.projectKey,
  async (key) => {
    templates.value = [];
    chosenId.value = '';
    chosen = null;
    if (!key) return;
    try {
      const r = await get(`/api/projects/${key}/templates`);
      if (props.projectKey === key) templates.value = r.templates;
    } catch {
      /* none */
    }
  },
  { immediate: true },
);

/** The summary with a prefix ("[Bug] ") or a {title} pattern applied once. Same rule as the server. */
function withPrefix(prefix, title) {
  if (!prefix) return title;
  if (prefix.includes('{title}')) return prefix.replace('{title}', title);
  return title.startsWith(prefix) ? title : prefix + title;
}
function stripPrefix(prefix, title) {
  if (!prefix || prefix.includes('{title}')) return title;
  return title.startsWith(prefix) ? title.slice(prefix.length) : title;
}

function pick() {
  const prev = chosen;
  const t = templates.value.find((x) => x.id === chosenId.value) || null;
  chosen = t;
  if (!t) return;
  let title = props.title || '';
  if (prev) title = stripPrefix(prev.titlePrefix, title);
  // keep what the person already wrote; replace an untouched description from the previous template
  const desc = props.description || '';
  let description = t.description || desc;
  if (desc && desc !== prev?.description && t.description) description = `${desc}\n\n${t.description}`;
  emit('apply', {
    type: t.type,
    title: t.titlePrefix?.includes('{title}') && !title ? '' : withPrefix(t.titlePrefix, title),
    description,
    ...(t.priority ? { priority: t.priority } : {}),
    labels: [...new Set([...(props.labels || []), ...t.labels])],
    ...(t.fields && Object.keys(t.fields).length ? { fields: t.fields } : {}), // default custom field values
    ...(t.components?.length ? { components: t.components } : {}), // default components (ids)
  });
}

/** Create the template's sub-tasks under the new issue. Returns how many were created. */
async function afterCreate(issue) {
  const t = chosen;
  if (!t?.subtasks?.length || !['story', 'task', 'bug'].includes(issue.type)) return 0;
  let n = 0;
  for (const title of t.subtasks) {
    try {
      await post('/api/issues', { projectKey: issue.projectKey, type: 'subtask', parentKey: issue.key, title });
      n++;
    } catch (e) {
      toast(`Sub-task "${title}" was not created: ${e.message}`, 'error');
    }
  }
  return n;
}
defineExpose({ afterCreate });
</script>

<template>
  <div v-if="templates.length">
    <label class="label" for="ci-template">Template</label>
    <select id="ci-template" v-model="chosenId" class="input" @change="pick">
      <option value="">No template</option>
      <option v-for="t in templates" :key="t.id" :value="t.id">
        {{ t.name }}{{ t.subtasks.length ? ` (${t.subtasks.length} sub-tasks)` : '' }}
      </option>
    </select>
  </div>
</template>
