<script setup>
// The status dropdown of one issue. It follows the project's workflow rules: moves that are not allowed
// are disabled, values a rule needs are asked for in the dialog, and a refused or cancelled change puts
// the select back. Classes given to the component land on the <select>.
import { toast } from '../api.js';
import { changeStatus } from '../issues.js';
import { canMoveTo } from '../workflow.js';

const props = defineProps({
  issue: { type: Object, required: true },
  project: { type: Object, required: true }, // the project payload: statuses, workflow, fields
  label: { type: String, default: 'Status' },
});
const emit = defineEmits(['changed']); // the server's answer { issue, changed }

async function onChange(e) {
  try {
    emit('changed', await changeStatus(props.project, props.issue, e.target.value));
  } catch (err) {
    e.target.value = props.issue.status.id;
    if (!err.cancelled) toast(err.message, 'error');
  }
}
</script>
<template>
  <select :value="issue.status.id" :aria-label="label" @change="onChange">
    <option v-for="s in project.statuses" :key="s.id" :value="s.id" :disabled="!canMoveTo(project, issue.status.id, s.id)">
      {{ s.name }}
    </option>
  </select>
</template>
