<script setup>
// Saved board views: switch, save the current filters, rename, update, delete, set the default (remembered on the
// server per person and project). API: /api/projects/:key/board-views (server/routes/boardViews.js).
import { ref, computed, onMounted } from 'vue';
import { get, post, patch, put, del, toast } from '../api.js';
import { attempt } from '../composables/useAction.js';

const props = defineProps({ projectKey: String, filters: Object, applyDefault: { type: Boolean, default: true } });
const emit = defineEmits(['apply']);
const views = ref([]);
const defaultId = ref(null);
const canShare = ref(false);
const current = ref(null); // id of the view last applied
const open = ref(false);
const form = ref(null); // { mode: 'new' | 'rename', name, shared }

const base = computed(() => `/api/projects/${props.projectKey}/board-views`);
const currentView = computed(() => views.value.find((v) => v.id === current.value) || null);
const mineList = computed(() => views.value.filter((v) => v.mine && !v.shared));
const sharedList = computed(() => views.value.filter((v) => v.shared));

async function load() {
  try {
    const r = await get(base.value);
    views.value = r.views;
    defaultId.value = r.defaultId;
    canShare.value = r.canShare;
  } catch {
    views.value = [];
  }
}
onMounted(async () => {
  await load();
  const d = views.value.find((v) => v.id === defaultId.value);
  if (d && props.applyDefault) apply(d);
});

function apply(v) {
  current.value = v.id;
  open.value = false;
  emit('apply', { ...v.filters });
}
const snapshot = () => JSON.parse(JSON.stringify(props.filters));

async function submitForm() {
  const f = form.value;
  if (!f.name.trim()) return;
  await attempt(async () => {
    if (f.mode === 'new') {
      const r = await post(base.value, { name: f.name, shared: f.shared, filters: snapshot() });
      current.value = r.view.id;
    } else {
      await patch(`${base.value}/${current.value}`, { name: f.name, shared: f.shared });
    }
    form.value = null;
    await load();
  });
}
async function updateFilters() {
  await attempt(async () => {
    await patch(`${base.value}/${current.value}`, { filters: snapshot() });
    toast('View updated');
    await load();
  });
}
async function remove() {
  const v = currentView.value;
  if (!v || !confirm(`Delete the view "${v.name}"?`)) return;
  await attempt(async () => {
    await del(`${base.value}/${v.id}`);
    current.value = null;
    await load();
  });
}
async function toggleDefault() {
  await attempt(async () => {
    const id = defaultId.value === current.value ? null : current.value;
    defaultId.value = (await put(`${base.value}/default`, { viewId: id })).defaultId;
  });
}
function startNew() {
  form.value = { mode: 'new', name: '', shared: false };
}
function startRename() {
  form.value = { mode: 'rename', name: currentView.value.name, shared: currentView.value.shared };
}
</script>

<template>
  <div class="relative">
    <button
      class="btn btn-sm"
      :aria-expanded="open"
      @click="
        open = !open;
        form = null;
      "
    >
      {{ currentView ? currentView.name : 'Views' }} <span aria-hidden="true">▾</span>
    </button>
    <div v-if="open" class="fixed inset-0 z-30" @click="open = false"></div>
    <div
      v-if="open"
      class="fixed left-2 right-2 top-28 z-40 rounded-[15px] border border-slate-200 bg-white p-2 text-sm shadow-xl sm:absolute sm:left-0 sm:right-auto sm:top-full sm:mt-1 sm:w-72"
      role="menu"
      aria-label="Board views"
    >
      <p v-if="!views.length && !form" class="px-2 py-2 text-slate-500">
        No saved views yet. Set the filters you want, then save them as a view.
      </p>
      <template
        v-for="group in [
          ['My views', mineList],
          ['Shared with the project', sharedList],
        ]"
        :key="group[0]"
      >
        <div v-if="group[1].length" class="mb-1">
          <div class="px-2 pb-0.5 pt-1 text-xs font-semibold uppercase text-slate-500">{{ group[0] }}</div>
          <button
            v-for="v in group[1]"
            :key="v.id"
            role="menuitem"
            class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-slate-100"
            :class="v.id === current ? 'bg-blue-50 text-blue-900' : ''"
            @click="apply(v)"
          >
            <span class="min-w-0 flex-1 truncate">{{ v.name }}</span>
            <span v-if="v.shared && !v.mine" class="truncate text-xs text-slate-500">{{ v.owner.name }}</span>
            <span v-if="v.id === defaultId" class="chip bg-slate-100 text-slate-600">Default</span>
          </button>
        </div>
      </template>
      <form v-if="form" class="space-y-2 border-t border-slate-200 px-2 pt-2" @submit.prevent="submitForm">
        <input
          v-model="form.name"
          class="input"
          maxlength="80"
          :placeholder="form.mode === 'new' ? 'Name of the view' : 'New name'"
          aria-label="View name"
          autofocus
        />
        <label v-if="canShare" class="flex items-center gap-1.5 text-xs text-slate-600"
          ><input v-model="form.shared" type="checkbox" />Share with the project</label
        >
        <div class="flex gap-2">
          <button class="btn btn-primary btn-sm" :disabled="!form.name.trim()">
            {{ form.mode === 'new' ? 'Save view' : 'Save' }}</button><button type="button" class="btn btn-sm" @click="form = null">
            Cancel
          </button>
        </div>
      </form>
      <div v-else class="mt-1 flex flex-col border-t border-slate-200 pt-1">
        <button class="rounded px-2 py-1.5 text-left hover:bg-slate-100" @click="startNew">Save current filters as a view</button>
        <template v-if="currentView">
          <button v-if="currentView.canEdit" class="rounded px-2 py-1.5 text-left hover:bg-slate-100" @click="updateFilters">
            Update "{{ currentView.name }}" with current filters
          </button>
          <button v-if="currentView.canEdit" class="rounded px-2 py-1.5 text-left hover:bg-slate-100" @click="startRename">
            Rename or change sharing
          </button>
          <button class="rounded px-2 py-1.5 text-left hover:bg-slate-100" @click="toggleDefault">
            {{ defaultId === current ? 'Stop using as my default' : 'Use as my default' }}
          </button>
          <button v-if="currentView.canDelete" class="rounded px-2 py-1.5 text-left text-red-700 hover:bg-red-50" @click="remove">
            Delete view
          </button>
        </template>
      </div>
    </div>
  </div>
</template>
