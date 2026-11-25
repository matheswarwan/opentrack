<script setup>
// The Trash: deleted issues you can restore (your own, or every issue in projects you admin; admins see all).
import { ref, onMounted, computed } from 'vue';
import { useRoute } from 'vue-router';
import { get, post, del, api, toast, session } from '../api.js';
import { projectsChanged } from '../ui.js';
import { ago, fmtDate, fmtDateTime } from '../meta.js';
import TypeIcon from '../components/TypeIcon.vue';
import Skeleton from '../components/Skeleton.vue';
import { attempt } from '../composables/useAction.js';
import { plural } from '../plural.js';

const data = ref(null);
const error = ref('');
const busy = ref('');
const confirmKey = ref('');
const route = useRoute();
const project = ref(String(route.query.project || '').toUpperCase());
const offset = ref(0);
const LIMIT = 100;

async function load() {
  error.value = '';
  try {
    const q = new URLSearchParams({ limit: String(LIMIT), offset: String(offset.value) });
    if (project.value) q.set('project', project.value);
    data.value = await get(`/api/trash?${q}`);
  } catch (e) {
    error.value = e.message;
  }
}
onMounted(load);

// Deleted projects (workspace admins)
const deletedProjects = ref([]);
const purgeTarget = ref(null);
const purgeKey = ref('');
async function loadProjectTrash() {
  if (session.user?.role !== 'admin') return;
  try {
    deletedProjects.value = (await get('/api/project-trash')).projects;
  } catch {
    deletedProjects.value = [];
  }
}
onMounted(loadProjectTrash);
async function restoreProject(p) {
  busy.value = `project:${p.key}`;
  await attempt(async () => {
    await post(`/api/project-trash/${p.key}/restore`);
    toast(`Project ${p.key} restored`);
    projectsChanged();
    await Promise.all([loadProjectTrash(), load()]);
  });
  busy.value = '';
}
async function purgeProjectNow(p) {
  busy.value = `project:${p.key}`;
  await attempt(async () => {
    await api('DELETE', `/api/project-trash/${p.key}`, { confirm: purgeKey.value });
    toast(`Project ${p.key} deleted for good`);
    purgeTarget.value = null;
    purgeKey.value = '';
    await loadProjectTrash();
  });
  busy.value = '';
}

const projects = computed(() => {
  const m = new Map();
  for (const i of data.value?.items || []) m.set(i.project.key, i.project.name);
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
});

async function restore(item) {
  busy.value = item.key;
  await attempt(async () => {
    const r = await post(`/api/trash/${item.key}/restore`);
    const extra = [
      r.subtasks ? `with ${r.subtasks} ${plural(r.subtasks, 'sub-task')}` : '',
      r.parentDropped ? `without its parent ${r.parentDropped}, which is gone` : '',
    ]
      .filter(Boolean)
      .join(', ');
    toast(`${item.key} restored${extra ? ` ${extra}` : ''}`);
    await load();
  });
  busy.value = '';
}

async function purge(item) {
  busy.value = item.key;
  await attempt(async () => {
    await del(`/api/trash/${item.key}`);
    toast(`${item.key} deleted for good`);
    confirmKey.value = '';
    await load();
  });
  busy.value = '';
}
function page(dir) {
  offset.value = Math.max(0, offset.value + dir * LIMIT);
  load();
}
</script>

<template>
  <div class="mx-auto max-w-4xl space-y-4">
    <div>
      <h1 class="text-xl font-semibold">Trash</h1>
      <p class="text-sm text-slate-600">
        Deleted issues stay here for {{ data?.trashDays || 30 }} days, then they are removed for good with their comments, work log and
        files. You see the issues you reported<span v-if="session.user?.role === 'admin'"> and, as an admin, every deleted issue</span
        ><span v-else> and every deleted issue in projects you admin</span>. Restoring an issue brings back the sub-tasks that were deleted
        with it. Issue keys are never reused.
      </p>
    </div>

    <section v-if="deletedProjects.length" class="card" aria-labelledby="deleted-projects" data-deleted-projects>
      <h2 id="deleted-projects" class="border-b border-slate-200 px-4 py-2 text-sm font-semibold">Deleted projects</h2>
      <ul class="divide-y divide-slate-100">
        <li
          v-for="p in deletedProjects"
          :key="p.key"
          class="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm"
          :data-deleted-project="p.key"
        >
          <span class="rounded bg-slate-100 px-1.5 text-xs font-bold">{{ p.key }}</span>
          <div class="min-w-0 flex-1">
            <div class="font-medium">
              {{ p.name }} <span class="font-normal text-slate-600">({{ p.issues }} {{ plural(p.issues, 'issue') }})</span>
            </div>
            <div class="text-xs text-slate-600">
              Deleted {{ ago(p.deletedAt) }}<template v-if="p.deletedBy"> by {{ p.deletedBy }}</template> · removed for good on
              {{ fmtDate(p.purgeAfter) }}
            </div>
          </div>
          <button type="button" class="btn btn-sm" :disabled="busy === `project:${p.key}`" @click="restoreProject(p)">Restore</button>
          <button
            v-if="purgeTarget !== p.key"
            type="button"
            class="btn btn-sm btn-danger"
            @click="
              purgeTarget = p.key;
              purgeKey = '';
            "
          >
            Delete forever
          </button>
          <form v-else class="flex w-full flex-wrap items-end gap-2" @submit.prevent="purgeProjectNow(p)">
            <label class="w-56"
              ><span class="label">Type {{ p.key }} to delete it and every issue for good</span
              ><input v-model="purgeKey" class="input uppercase" autocomplete="off" :placeholder="p.key"
            /></label>
            <button
              type="submit"
              class="btn btn-sm btn-danger"
              :disabled="purgeKey.trim().toUpperCase() !== p.key || busy === `project:${p.key}`"
            >
              Delete forever
            </button>
            <button type="button" class="btn btn-sm btn-ghost" @click="purgeTarget = null">Cancel</button>
          </form>
        </li>
      </ul>
    </section>

    <div v-if="projects.length > 1 || project" class="flex flex-wrap items-center gap-2">
      <label class="text-sm text-slate-600" for="trash-project">Project</label>
      <select
        id="trash-project"
        v-model="project"
        class="input w-56"
        @change="
          offset = 0;
          load();
        "
      >
        <option value="">All projects</option>
        <option v-for="[k, n] in projects" :key="k" :value="k">{{ k }}: {{ n }}</option>
      </select>
    </div>

    <p v-if="error" class="text-sm text-red-700">{{ error }}</p>
    <Skeleton v-else-if="!data" card :rows="4" />
    <div v-else class="card">
      <p v-if="!data.items.length" class="px-4 py-8 text-center text-sm text-slate-500">The Trash is empty.</p>
      <ul v-else class="divide-y divide-slate-100">
        <li v-for="i in data.items" :key="i.key" class="space-y-2 px-4 py-3">
          <div class="flex flex-wrap items-start gap-x-3 gap-y-2">
            <div class="flex min-w-0 flex-1 items-start gap-2">
              <TypeIcon :type="i.type" class="mt-0.5" />
              <div class="min-w-0">
                <div class="text-sm">
                  <span class="font-mono text-xs text-slate-500">{{ i.key }}</span>
                  <span class="break-words font-medium">{{ i.title }}</span>
                </div>
                <div class="text-xs text-slate-500">
                  {{ i.project.name }}<span v-if="i.subtasks"> · {{ i.subtasks }} {{ plural(i.subtasks, 'sub-task') }}</span> · Deleted
                  <span :title="fmtDateTime(i.deletedAt)">{{ ago(i.deletedAt) }}</span><span v-if="i.deletedBy">
                    by {{ i.deletedBy.name }}</span
                  >
                  · Removed for good after {{ fmtDate(i.purgeAfter) }}
                </div>
              </div>
            </div>
            <div class="flex shrink-0 gap-2">
              <button class="btn btn-sm" :disabled="busy === i.key" @click="restore(i)">Restore</button>
              <button
                v-if="i.canPurge"
                class="btn btn-sm btn-danger"
                :disabled="busy === i.key"
                @click="confirmKey = confirmKey === i.key ? '' : i.key"
              >
                Delete forever
              </button>
            </div>
          </div>
          <div v-if="confirmKey === i.key" class="flex flex-wrap items-center gap-2 rounded-md bg-red-50 p-2 text-sm">
            <span class="flex-1"
              >Delete {{ i.key }}{{ i.subtasks ? ` and its ${i.subtasks} ${plural(i.subtasks, 'sub-task')}` : '' }} for good, with comments,
              work log and files? This cannot be undone.</span
            >
            <button class="btn btn-sm btn-danger" :disabled="busy === i.key" @click="purge(i)">Delete forever</button>
            <button class="btn btn-sm" @click="confirmKey = ''">Cancel</button>
          </div>
        </li>
      </ul>
      <div v-if="data.total > data.items.length" class="flex items-center justify-between border-t border-slate-100 px-4 py-2 text-sm">
        <span class="text-slate-500">{{ data.offset + 1 }} to {{ data.offset + data.items.length }} of {{ data.total }}</span>
        <span class="flex gap-2">
          <button class="btn btn-sm" :disabled="data.offset === 0" @click="page(-1)">Previous</button>
          <button class="btn btn-sm" :disabled="data.offset + data.items.length >= data.total" @click="page(1)">Next</button>
        </span>
      </div>
    </div>
  </div>
</template>
