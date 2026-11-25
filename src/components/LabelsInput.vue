<script setup>
import { ref } from 'vue';
import { get } from '../api.js';
const props = defineProps({ modelValue: { type: Array, default: () => [] } });
const emit = defineEmits(['update:modelValue']);
const text = ref('');
const suggestions = ref([]);
let timer;
function add(l) {
  const v = String(l || text.value)
    .trim()
    .replace(/\s+/g, '-');
  if (v && !props.modelValue.includes(v)) emit('update:modelValue', [...props.modelValue, v]);
  text.value = '';
  suggestions.value = [];
}
function remove(l) {
  emit(
    'update:modelValue',
    props.modelValue.filter((x) => x !== l),
  );
}
function search() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    if (!text.value) {
      suggestions.value = [];
      return;
    }
    const r = await get(`/api/labels?q=${encodeURIComponent(text.value)}`);
    suggestions.value = r.labels.filter((l) => !props.modelValue.includes(l)).slice(0, 8);
  }, 200);
}
</script>
<template>
  <div class="relative">
    <div class="flex flex-wrap items-center gap-1 rounded-md border border-slate-300 bg-white px-1.5 py-1">
      <span v-for="l in modelValue" :key="l" class="chip bg-slate-100 text-slate-700"
        >{{ l
        }}<button type="button" class="ml-1 text-slate-400 hover:text-slate-700" :aria-label="'Remove ' + l" @click="remove(l)">
          ×
        </button></span
      >
      <input
        v-model="text"
        class="w-20 min-w-0 flex-1 border-0 px-1 py-0.5 text-sm outline-none"
        placeholder="Add label"
        @input="search"
        @keydown.enter.prevent="add()"
        @keydown.backspace="!text && modelValue.length && remove(modelValue[modelValue.length - 1])"
        @blur="text && add()"
      />
    </div>
    <div v-if="suggestions.length" class="absolute z-40 mt-1 w-56 rounded-md border border-slate-200 bg-white py-1 shadow-lg">
      <button
        v-for="s in suggestions"
        :key="s"
        type="button"
        class="block w-full px-3 py-1 text-left text-sm hover:bg-slate-100"
        @mousedown.prevent="add(s)"
      >
        {{ s }}
      </button>
    </div>
  </div>
</template>
