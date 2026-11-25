<script setup>
// "More filters" on the Issues page: conditions on one project's custom fields, as cf.<id> and cf.<id>.empty search
// parameters. v-model is an object of those parameters; `apply` runs the search.
import { ref, computed } from 'vue';
import { users as loadUsers } from '../api.js';

const props = defineProps({ fields: { type: Array, default: () => [] }, modelValue: { type: Object, default: () => ({}) } });
const emit = defineEmits(['update:modelValue', 'apply']);
const open = ref(false);
const people = ref([]);
const count = computed(() => Object.keys(props.modelValue).length);

async function toggle() {
  open.value = !open.value;
  if (open.value && !people.value.length && props.fields.some((f) => f.type === 'user')) people.value = await loadUsers();
}
// one control per field: '' = any, '__empty' = no value, '__any' = has a value, otherwise the value
const current = (f) => {
  const m = props.modelValue;
  if (m[`cf.${f.id}.empty`] === '1') return '__empty';
  if (m[`cf.${f.id}.empty`] === '0') return '__any';
  return m[`cf.${f.id}`] || '';
};
function set(f, v) {
  const next = { ...props.modelValue };
  delete next[`cf.${f.id}`];
  delete next[`cf.${f.id}.empty`];
  if (v === '__empty') next[`cf.${f.id}.empty`] = '1';
  else if (v === '__any') next[`cf.${f.id}.empty`] = '0';
  else if (v !== '') next[`cf.${f.id}`] = v;
  emit('update:modelValue', next);
}
const choice = (f) => ['select', 'multiselect', 'checkbox', 'user'].includes(f.type);
function clear() {
  emit('update:modelValue', {});
  emit('apply');
}
</script>

<template>
  <div v-if="fields.length" class="relative">
    <button type="button" class="btn" :aria-expanded="open" @click="toggle">
      More filters<span v-if="count" class="ml-1 rounded-full bg-slate-200 px-1.5 text-xs">{{ count }}</span>
    </button>
    <div v-if="open" class="fixed inset-0 z-30" @click="open = false"></div>
    <form
      v-if="open"
      class="absolute left-0 z-40 mt-1 w-[min(22rem,calc(100vw-2rem))] space-y-2 rounded-[15px] border border-slate-200 bg-white p-3 shadow-lg"
      @submit.prevent="
        open = false;
        emit('apply');
      "
    >
      <div v-for="f in fields" :key="f.id">
        <label class="label" :for="'ff-' + f.id">{{ f.name }}</label>
        <select v-if="choice(f)" :id="'ff-' + f.id" :value="current(f)" class="input py-1" @change="set(f, $event.target.value)">
          <option value="">Any</option>
          <template v-if="f.type === 'checkbox'"
            ><option value="1">Yes</option>
            <option value="0">No</option></template
          >
          <template v-else-if="f.type === 'user'"
            ><option v-for="u in people" :key="u.id" :value="u.id">{{ u.name }}</option></template
          >
          <template v-else
            ><option v-for="o in f.options" :key="o.id" :value="o.id">{{ o.name }}{{ o.archived ? ' (archived)' : '' }}</option></template
          >
          <option value="__any">Has a value</option>
          <option value="__empty">No value</option>
        </select>
        <div v-else class="flex gap-2">
          <input
            :id="'ff-' + f.id"
            :type="f.type === 'date' ? 'date' : f.type === 'number' ? 'number' : 'text'"
            step="any"
            :value="current(f).startsWith('__') ? '' : current(f)"
            class="input py-1"
            :placeholder="['text', 'longtext', 'url'].includes(f.type) ? 'Contains' : 'Equals'"
            @change="set(f, $event.target.value.trim())"
          />
          <select
            :value="current(f).startsWith('__') ? current(f) : ''"
            class="input w-28 py-1"
            :aria-label="`${f.name}: empty or not`"
            @change="set(f, $event.target.value)"
          >
            <option value="">Any</option>
            <option value="__any">Has a value</option>
            <option value="__empty">No value</option>
          </select>
        </div>
      </div>
      <div class="flex gap-2 pt-1">
        <button class="btn btn-primary btn-sm">Apply</button
        ><button
          type="button"
          class="btn btn-sm"
          @click="
            open = false;
            clear();
          "
        >
          Clear field filters
        </button>
      </div>
    </form>
  </div>
</template>
