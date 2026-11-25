<script setup>
import { ref, provide, watch, computed } from 'vue';
import { useRoute } from 'vue-router';
import { session } from '../../api.js';
import { project as fetchProject, forgetProjects } from '../../projects.js';
import { ui } from '../../ui.js';
import { rememberProject } from '../../recent.js';

const route = useRoute();
const project = ref(null);
const error = ref('');
// Always a fresh copy (the store keeps it for the drawer and the views under this layout).
async function load() {
  try {
    project.value = await fetchProject(route.params.key, true);
    ui.lastProjectKey = project.value.key;
    rememberProject(project.value.key);
    error.value = '';
  } catch (e) {
    error.value = e.message;
  }
}
watch(() => route.params.key, load, { immediate: true });
provide('project', project);
// after a change to the project (settings, sprints, releases): the list is stale too (name, counts)
provide('reloadProject', () => {
  forgetProjects(route.params.key);
  return load();
});
const tabs = computed(() => [
  { to: 'board', label: 'Board' },
  { to: 'backlog', label: 'Backlog' },
  { to: 'issues', label: 'Issues' },
  { to: 'roadmap', label: 'Roadmap' },
  { to: 'calendar', label: 'Calendar' },
  { to: 'releases', label: 'Releases' },
  { to: 'activity', label: 'Activity' },
  { to: 'reports', label: 'Reports' },
  { to: 'status', label: 'Status' },
  ...(session.user?.role !== 'guest' ? [{ to: 'raid', label: 'RAID' }] : []),
  ...(project.value?.canEdit && project.value?.canCreate && !project.value?.canAdmin ? [{ to: 'recurring', label: 'Recurring' }] : []), // admins: under Settings
  ...(project.value?.canAdmin ? [{ to: 'settings', label: 'Settings' }] : []),
]);
</script>
<template>
  <div v-if="error" class="py-16 text-center text-slate-600">{{ error }}</div>
  <template v-else-if="project">
    <div class="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-200">
      <div class="pb-2">
        <div class="text-xs text-slate-500">
          <RouterLink to="/projects" class="hover:underline">Projects</RouterLink> / {{ project.key }}
        </div>
        <h1 class="text-lg font-semibold">
          {{ project.name }} <span v-if="project.archived" class="chip bg-slate-200 text-slate-600">Archived</span>
        </h1>
      </div>
      <nav class="flex max-w-full gap-1 self-end overflow-x-auto">
        <RouterLink
          v-for="t in tabs"
          :key="t.to"
          :to="`/projects/${project.key}/${t.to}`"
          class="shrink-0 px-3 py-2 text-sm"
          :class="
            route.path.endsWith('/' + t.to) ||
            (t.to === 'releases' && route.path.includes('/releases/')) ||
            (t.to === 'status' && route.path.includes('/status/'))
              ? 'border-b-2 border-blue-700 font-semibold text-blue-800'
              : 'text-slate-600 hover:text-slate-900'
          "
          >{{ t.label }}</RouterLink
        >
      </nav>
    </div>
    <RouterView :key="project.id" />
  </template>
</template>
