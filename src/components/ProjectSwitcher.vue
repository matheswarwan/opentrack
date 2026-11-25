<script setup>
// Project switcher: like a business unit switcher, at the top of
// the sidebar. Lists every project (recent first) with a filter, Browse all projects
// and New project. Picking one keeps you on the same project page.
import { ref, computed, nextTick, onBeforeUnmount } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { session } from '../api.js';
import Icon from './Icon.vue';
import { orderProjects, switchPath, filterProjects } from '../projectSwitch.js';

const props = defineProps({
  projects: { type: Array, default: () => [] },
  recent: { type: Array, default: () => [] },
  current: { type: String, default: null },
  compact: Boolean,
});
const router = useRouter();
const route = useRoute();
const open = ref(false);
const text = ref('');
const active = ref(0);
const root = ref(null);
const input = ref(null);

const ordered = computed(() => orderProjects(props.projects, props.recent));
const shown = computed(() => filterProjects(ordered.value, text.value));
const currentProject = computed(() => props.projects.find((p) => p.key === props.current) || null);

function onDoc(e) {
  if (root.value && !root.value.contains(e.target)) close();
}
async function toggle() {
  if (open.value) return close();
  open.value = true;
  text.value = '';
  active.value = 0;
  document.addEventListener('mousedown', onDoc);
  await nextTick();
  input.value?.focus();
}
function close() {
  open.value = false;
  document.removeEventListener('mousedown', onDoc);
}
onBeforeUnmount(() => document.removeEventListener('mousedown', onDoc));
function pick(p) {
  close();
  router.push(switchPath(route.path, p.key));
}
function go(path) {
  close();
  router.push(path);
}
function onKey(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
    root.value?.querySelector('button')?.focus();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    active.value = Math.min(active.value + 1, shown.value.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    active.value = Math.max(active.value - 1, 0);
  } else if (e.key === 'Enter' && shown.value[active.value]) {
    e.preventDefault();
    pick(shown.value[active.value]);
  }
}
</script>

<template>
  <div ref="root" class="relative">
    <button
      type="button"
      class="flex w-full items-center gap-2 rounded-lg border border-white/20 bg-white/5 px-2.5 py-1.5 text-left text-sm hover:bg-white/10"
      :class="compact ? 'justify-center px-0' : ''"
      :aria-expanded="open"
      aria-haspopup="dialog"
      :title="currentProject ? `Project: ${currentProject.name} (switch project)` : 'Switch project'"
      @click="toggle"
    >
      <span class="flex h-5 min-w-[1.75rem] items-center justify-center rounded bg-white/15 px-1 text-[10px] font-bold">{{
        currentProject?.key || '...'
      }}</span>
      <template v-if="!compact">
        <span class="min-w-0 flex-1 truncate">{{ currentProject?.name || 'Switch project' }}</span>
        <svg
          class="h-3.5 w-3.5 shrink-0 text-white/70"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <path d="M7 10l5 5 5-5" />
        </svg>
      </template>
      <span class="sr-only">Switch project</span>
    </button>
    <div
      v-if="open"
      role="dialog"
      aria-label="Switch project"
      class="absolute left-0 top-full z-50 mt-1 w-72 overflow-hidden rounded-lg border border-slate-200 bg-white text-slate-800 shadow-xl"
      @keydown="onKey"
    >
      <div class="border-b border-slate-200 p-2">
        <label class="sr-only" for="project-switch-filter">Find a project</label>
        <input
          id="project-switch-filter"
          ref="input"
          v-model="text"
          class="input py-1 text-sm"
          placeholder="Find a project"
          autocomplete="off"
          @input="active = 0"
        />
      </div>
      <ul class="max-h-72 overflow-y-auto py-1 text-sm" aria-label="Projects">
        <li v-for="(p, i) in shown" :key="p.id">
          <button
            type="button"
            class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left"
            :class="i === active ? 'bg-slate-100' : 'hover:bg-slate-50'"
            :aria-current="p.key === current ? 'true' : undefined"
            @click="pick(p)"
            @mouseenter="active = i"
          >
            <span
              class="flex h-5 min-w-[1.75rem] items-center justify-center rounded px-1 text-[10px] font-bold"
              :class="p.key === current ? 'bg-accent text-white' : 'bg-slate-200 text-slate-800'"
              >{{ p.key }}</span
            >
            <span class="min-w-0 flex-1 truncate">{{ p.name }}</span>
            <Icon v-if="p.key === current" name="check" :size="14" />
          </button>
        </li>
        <li v-if="!shown.length" class="px-3 py-3 text-slate-600">{{ projects.length ? 'No project matches' : 'No projects yet' }}</li>
      </ul>
      <div class="flex border-t border-slate-200 text-sm">
        <button type="button" class="flex-1 px-3 py-2 text-left hover:bg-slate-50" @click="go('/projects')">Browse all projects</button>
        <button
          v-if="session.canCreateProject"
          type="button"
          class="flex items-center gap-1 border-l border-slate-200 px-3 py-2 hover:bg-slate-50"
          @click="go('/projects?new=1')"
        >
          <Icon name="plus" :size="14" />New project
        </button>
      </div>
    </div>
  </div>
</template>
