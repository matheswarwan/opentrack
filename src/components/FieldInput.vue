<script setup>
// Edits one custom field value. v-model is the API value (option id, list of option ids, user id, boolean, number, text).
// Text-like inputs emit on change (blur or Enter), the rest at once.
import { computed } from 'vue';
import UserSelect from './UserSelect.vue';

const props = defineProps({ field: { type: Object, required: true }, modelValue: { default: null }, compact: Boolean, id: String });
const emit = defineEmits(['update:modelValue']);
const set = (v) => emit('update:modelValue', v);
const cls = computed(() => (props.compact ? 'input py-1' : 'input'));
// options that can be picked: active ones, plus an archived one already chosen
const options = computed(() => {
  const chosen = new Set(Array.isArray(props.modelValue) ? props.modelValue : [props.modelValue]);
  return (props.field.options || []).filter((o) => !o.archived || chosen.has(o.id));
});
const list = computed(() => (Array.isArray(props.modelValue) ? props.modelValue : []));
function toggle(id) {
  const next = list.value.includes(id) ? list.value.filter((x) => x !== id) : [...list.value, id];
  set(next);
}
</script>

<template>
  <input
    v-if="field.type === 'text' || field.type === 'url'"
    :id="id"
    :type="field.type === 'url' ? 'url' : 'text'"
    :value="modelValue ?? ''"
    :class="cls"
    :maxlength="field.type === 'url' ? 2000 : 500"
    :placeholder="field.type === 'url' ? 'https://' : ''"
    :aria-label="field.name"
    @change="set($event.target.value.trim() || null)"
  />
  <textarea
    v-else-if="field.type === 'longtext'"
    :id="id"
    :value="modelValue ?? ''"
    :class="cls"
    rows="3"
    maxlength="10000"
    :aria-label="field.name"
    @change="set($event.target.value || null)"
  ></textarea>
  <input
    v-else-if="field.type === 'number'"
    :id="id"
    type="number"
    step="any"
    :value="modelValue ?? ''"
    :class="cls"
    :aria-label="field.name"
    @change="set($event.target.value === '' ? null : Number($event.target.value))"
  />
  <input
    v-else-if="field.type === 'date'"
    :id="id"
    type="date"
    :value="modelValue ?? ''"
    :class="cls"
    :aria-label="field.name"
    @change="set($event.target.value || null)"
  />
  <label v-else-if="field.type === 'checkbox'" class="flex items-center gap-2 py-1 text-sm">
    <input :id="id" type="checkbox" :checked="modelValue === true" @change="set($event.target.checked)" />{{
      modelValue === true ? 'Yes' : 'No'
    }}
  </label>
  <select
    v-else-if="field.type === 'select'"
    :id="id"
    :value="modelValue ?? ''"
    :class="cls"
    :aria-label="field.name"
    @change="set($event.target.value || null)"
  >
    <option value="">None</option>
    <option v-for="o in options" :key="o.id" :value="o.id">{{ o.name }}{{ o.archived ? ' (archived)' : '' }}</option>
  </select>
  <div v-else-if="field.type === 'multiselect'" :id="id" class="flex flex-wrap gap-1 py-1" role="group" :aria-label="field.name">
    <button
      v-for="o in options"
      :key="o.id"
      type="button"
      class="chip border"
      :class="
        list.includes(o.id) ? 'border-accent bg-accent text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-400'
      "
      :aria-pressed="list.includes(o.id)"
      @click="toggle(o.id)"
    >
      {{ o.name }}
    </button>
  </div>
  <UserSelect
    v-else-if="field.type === 'user'"
    :compact="compact"
    placeholder="None"
    :model-value="modelValue || null"
    @update:model-value="set($event)"
  />
</template>
