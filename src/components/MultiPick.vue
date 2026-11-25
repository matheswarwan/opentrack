<script setup>
// Pick several items (components, fix versions). v-model is a list of ids; options: [{ id, name, note? }].
// Chosen items show as chips; ids no longer among the options still show (with their name from `known`).
import { computed } from 'vue';

const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  options: { type: Array, default: () => [] },
  known: { type: Array, default: () => [] }, // [{ id, name }] for chosen ids that are not options (archived releases)
  placeholder: { type: String, default: 'Add' },
  label: { type: String, default: '' },
  disabled: Boolean,
});
const emit = defineEmits(['update:modelValue']);
const nameOf = (id) => props.options.find((o) => o.id === id)?.name || props.known.find((o) => o.id === id)?.name || 'Removed';
const left = computed(() => props.options.filter((o) => !props.modelValue.includes(o.id)));
function add(e) {
  const id = e.target.value;
  e.target.value = '';
  if (id && !props.modelValue.includes(id)) emit('update:modelValue', [...props.modelValue, id]);
}
const remove = (id) =>
  emit(
    'update:modelValue',
    props.modelValue.filter((x) => x !== id),
  );
</script>

<template>
  <div class="flex min-w-0 flex-wrap items-center gap-1" role="group" :aria-label="label || null">
    <span v-for="id in modelValue" :key="id" class="chip max-w-full bg-slate-100 text-slate-700">
      <span class="truncate">{{ nameOf(id) }}</span>
      <button
        v-if="!disabled"
        type="button"
        class="ml-1 text-slate-400 hover:text-slate-700"
        :aria-label="`Remove ${nameOf(id)}`"
        @click="remove(id)"
      >
        ×
      </button>
    </span>
    <select
      v-if="!disabled && left.length"
      class="input w-auto max-w-full py-0.5 text-sm"
      :aria-label="label ? `Add ${label.toLowerCase()}` : placeholder"
      @change="add"
    >
      <option value="">{{ placeholder }}</option>
      <option v-for="o in left" :key="o.id" :value="o.id">{{ o.name }}{{ o.note ? ` (${o.note})` : '' }}</option>
    </select>
    <span v-if="disabled && !modelValue.length" class="text-slate-400">None</span>
  </div>
</template>
