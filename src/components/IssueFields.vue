<script setup>
// Custom field rows for the issue side panel. Shows the project's active fields that apply to the issue's type
// (and any other field that has a value). Emits update({ fields: { <id>: value } }).
import { computed } from 'vue';
import { activeFields, appliesTo, toApi, fieldText } from '../fields.js';
import FieldInput from './FieldInput.vue';
import Avatar from './Avatar.vue';

const props = defineProps({ issue: { type: Object, required: true }, fields: { type: Array, default: () => [] }, canEdit: Boolean });
const emit = defineEmits(['update']);
const shown = computed(() =>
  activeFields(props.fields).filter((f) => appliesTo(f, props.issue.type) || props.issue.fields?.[f.id] !== undefined),
);
const value = (f) => props.issue.fields?.[f.id];
function save(f, v) {
  const empty = v === null || v === '' || (Array.isArray(v) && !v.length);
  const before = toApi(f, value(f));
  if (JSON.stringify(empty ? null : v) === JSON.stringify(Array.isArray(before) && !before.length ? null : before)) return;
  emit('update', { fields: { [f.id]: empty ? null : v } });
}
</script>

<template>
  <div v-for="f in shown" :key="f.id" class="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-2 px-3 py-2">
    <span class="break-words text-slate-500" :title="f.help || null"
      >{{ f.name }}<span v-if="f.required" class="text-red-700" aria-label="required"> *</span></span
    >
    <FieldInput v-if="canEdit" compact :field="f" :model-value="toApi(f, value(f))" @update:model-value="save(f, $event)" />
    <span v-else-if="f.type === 'user' && value(f)" class="flex items-center gap-2"
      ><Avatar :user="value(f)" :size="22" />{{ value(f).name }}</span
    >
    <a v-else-if="f.type === 'url' && value(f)" :href="value(f)" target="_blank" rel="noopener noreferrer" class="link truncate">{{
      value(f)
    }}</a>
    <span v-else class="whitespace-pre-wrap break-words" :class="fieldText(f, value(f)) ? '' : 'text-slate-400'">{{
      fieldText(f, value(f)) || 'None'
    }}</span>
  </div>
</template>
