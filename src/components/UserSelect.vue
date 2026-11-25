<script setup>
// Searchable person picker. v-model is a user id (or null).
import { ref, computed, onMounted, nextTick } from 'vue';
import { users as loadUsers, session } from '../api.js';
import Avatar from './Avatar.vue';

const props = defineProps({
  modelValue: String,
  placeholder: { type: String, default: 'Unassigned' },
  allowNone: { type: Boolean, default: true },
  compact: Boolean,
  startOpen: Boolean,
  buttonLabel: String,
});
const emit = defineEmits(['update:modelValue']);
const all = ref([]);
const open = ref(false);
const q = ref('');
const input = ref(null);
onMounted(async () => {
  all.value = await loadUsers();
  if (props.startOpen) toggle();
});
const current = computed(() => all.value.find((u) => u.id === props.modelValue));
const filtered = computed(() => {
  const s = q.value.toLowerCase();
  return all.value.filter((u) => !s || u.name.toLowerCase().includes(s) || u.email.toLowerCase().includes(s)).slice(0, 50);
});
async function toggle() {
  open.value = !open.value;
  q.value = '';
  if (open.value) {
    await nextTick();
    input.value?.focus();
  }
}
function pick(id) {
  emit('update:modelValue', id);
  open.value = false;
}
</script>
<template>
  <div class="relative">
    <button
      type="button"
      class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-slate-100"
      :class="compact ? '' : 'border border-slate-300 bg-white'"
      @click="toggle"
    >
      <Avatar :user="current" :size="22" />
      <span class="truncate" :class="current ? '' : 'text-slate-500'">{{ current ? current.name : buttonLabel || placeholder }}</span>
    </button>
    <div v-if="open" class="absolute z-40 mt-1 w-64 rounded-md border border-slate-200 bg-white shadow-lg">
      <input
        ref="input"
        v-model="q"
        class="input rounded-b-none border-0 border-b"
        placeholder="Search people"
        @keydown.esc="open = false"
        @keydown.enter.prevent="filtered[0] && pick(filtered[0].id)"
      />
      <div class="max-h-64 overflow-y-auto py-1">
        <button
          v-if="session.user && modelValue !== session.user.id"
          type="button"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-blue-700 hover:bg-slate-100"
          @click="pick(session.user.id)"
        >
          Assign to me
        </button>
        <button
          v-if="allowNone"
          type="button"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-100"
          @click="pick(null)"
        >
          <Avatar :user="null" :size="20" /> {{ placeholder }}
        </button>
        <button
          v-for="u in filtered"
          :key="u.id"
          type="button"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-100"
          @click="pick(u.id)"
        >
          <Avatar :user="u" :size="20" /><span class="truncate">{{ u.name }}</span
          ><span v-if="u.invited" class="text-xs text-slate-400">invited</span>
        </button>
      </div>
    </div>
    <div v-if="open" class="fixed inset-0 z-30" @click="open = false"></div>
  </div>
</template>
