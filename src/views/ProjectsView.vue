<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { get, post, session, toast } from '../api.js';
import { today } from '../dates.js';
import { projectList } from '../projects.js';
import { projectsChanged } from '../ui.js';
import Modal from '../components/Modal.vue';
import UserSelect from '../components/UserSelect.vue';
import LoadState from '../components/LoadState.vue';
import { useLoad } from '../composables/useLoad.js';
import { templateParts, usesDates, joinParts } from '../projectTemplates.js';

const router = useRouter();
const route = useRoute();
const archived = ref(false);
const creating = ref(false);
const error = ref('');
const form = reactive({
  name: '',
  key: '',
  description: '',
  visibility: 'open',
  leadId: session.user.id,
  templateId: 'blank',
  startDate: today(),
});
// Project templates (built-in and saved): loaded when the dialog opens
const templates = ref([]);
const created = ref(null); // { key, text } after a project made from a template
const chosen = computed(() => templates.value.find((t) => t.id === form.templateId) || null);
async function openCreate() {
  creating.value = true;
  created.value = null;
  error.value = '';
  try {
    templates.value = (await get('/api/project-templates')).templates.filter((t) => t.summary);
  } catch {
    templates.value = []; // Blank still works
  }
}
const {
  data: projects,
  loading,
  error: loadError,
  reload: load,
} = useLoad(async () => (archived.value ? (await get('/api/projects?archived=1')).projects : projectList(true)), null, { initial: [] });
onMounted(() => {
  // the project switcher's New project opens this dialog
  if (route.query.new && session.canCreateProject) {
    router.replace({ query: {} });
    openCreate();
  }
});
function suggestKey() {
  if (form.keyTouched) return;
  const words = form.name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, '')
    .split(/\s+/)
    .filter(Boolean);
  form.key = (words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] || '').slice(0, 4)).slice(0, 10);
}
async function create() {
  error.value = '';
  try {
    const r = await post('/api/projects', { ...form, templateId: form.templateId === 'blank' ? undefined : form.templateId });
    toast(`Project ${r.project.key} created`);
    projectsChanged();
    if (r.template) {
      created.value = { key: r.project.key, name: r.template.name, text: `Created ${joinParts(templateParts(r.template.summary))}.` };
      return;
    }
    creating.value = false;
    router.push(`/projects/${r.project.key}/board`);
  } catch (e) {
    error.value = e.message;
  }
}
</script>
<template>
  <div class="mb-4 flex items-center gap-3">
    <h1 class="text-xl font-semibold">Projects</h1>
    <label class="ml-4 flex items-center gap-1.5 text-sm text-slate-600"
      ><input v-model="archived" type="checkbox" @change="load" /> Show archived</label
    >
    <button v-if="session.canCreateProject" class="btn btn-primary ml-auto" @click="openCreate">New project</button>
  </div>
  <LoadState v-if="loading || loadError" :loading="loading" :error="loadError" card @retry="load" />
  <div v-else class="card overflow-hidden">
    <table class="w-full text-sm">
      <thead class="bg-slate-50 text-left text-xs uppercase text-slate-500">
        <tr>
          <th class="px-3 py-2">Name</th>
          <th class="px-3 py-2">Key</th>
          <th class="px-3 py-2">Lead</th>
          <th class="px-3 py-2">Open issues</th>
          <th class="px-3 py-2">Access</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="p in projects"
          :key="p.id"
          class="cursor-pointer border-t border-slate-100 hover:bg-slate-50"
          @click="router.push(`/projects/${p.key}/board`)"
        >
          <td class="px-3 py-2 font-medium text-blue-800">
            {{ p.name }}
            <div v-if="p.description" class="truncate text-xs font-normal text-slate-500 max-w-md">{{ p.description }}</div>
          </td>
          <td class="px-3 py-2">{{ p.key }}</td>
          <td class="px-3 py-2">{{ p.leadName }}</td>
          <td class="px-3 py-2">{{ p.openIssues }}</td>
          <td class="px-3 py-2">
            <span class="chip" :class="p.visibility === 'private' ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600'">{{
              p.visibility === 'private' ? 'Members only' : 'Everyone'
            }}</span>
          </td>
        </tr>
        <tr v-if="!projects.length">
          <td colspan="5" class="px-3 py-12 text-center">
            <div class="font-medium text-slate-700">{{ archived ? 'No archived projects' : 'No projects yet' }}</div>
            <p class="mt-1 text-sm text-slate-500">A project holds a team's issues, board and sprints.</p>
            <button v-if="session.canCreateProject && !archived" class="btn btn-primary mt-3" @click="openCreate">
              Create the first project
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
  <Modal v-if="creating" title="New project" wide @close="creating = false">
    <div v-if="created" class="space-y-3" role="status">
      <p class="text-sm">
        Project <strong>{{ created.key }}</strong> was made from the template {{ created.name }}.
      </p>
      <p class="text-sm text-slate-700">{{ created.text }}</p>
      <p class="text-xs text-slate-500">
        Change any of it in Project settings. Recurring tasks start on their schedule; the first sprint is not started yet.
      </p>
    </div>
    <form v-else id="new-project" class="space-y-3" @submit.prevent="create">
      <fieldset>
        <legend class="label">Start from</legend>
        <div class="grid gap-2 sm:grid-cols-2">
          <label
            class="flex cursor-pointer gap-2 rounded-md border p-3 text-sm"
            :class="form.templateId === 'blank' ? 'border-black bg-surface' : 'border-slate-200'"
          >
            <input v-model="form.templateId" type="radio" name="np-template" value="blank" class="mt-0.5" />
            <span
              ><span class="font-semibold">Blank</span
              ><span class="block text-xs text-slate-600">To Do, In Progress, In Review and Done. Nothing else.</span></span
            >
          </label>
          <label
            v-for="t in templates"
            :key="t.id"
            class="flex cursor-pointer gap-2 rounded-md border p-3 text-sm"
            :class="form.templateId === t.id ? 'border-black bg-surface' : 'border-slate-200'"
          >
            <input v-model="form.templateId" type="radio" name="np-template" :value="t.id" class="mt-0.5" />
            <span class="min-w-0">
              <span class="font-semibold">{{ t.name }}</span>
              <span v-if="!t.builtin" class="chip ml-1 bg-slate-100 text-slate-600">{{
                t.visibility === 'shared' ? 'Shared' : 'Yours'
              }}</span>
              <span v-if="t.description" class="block text-xs text-slate-600">{{ t.description }}</span>
              <span class="mt-1 block text-xs text-slate-500">Sets up {{ joinParts(templateParts(t.summary)) }}.</span>
            </span>
          </label>
        </div>
      </fieldset>
      <div v-if="chosen && usesDates(chosen.summary)">
        <label class="label" for="np-start">Project start date (due dates such as "day 10" or "week 6" count from it)</label>
        <input id="np-start" v-model="form.startDate" type="date" class="input w-auto" required />
      </div>
      <div>
        <label class="label" for="np-name">Name</label
        ><input id="np-name" v-model="form.name" class="input" required autofocus @input="suggestKey" />
      </div>
      <div>
        <label class="label" for="np-key">Key (used in issue keys like {{ form.key || 'KEY' }}-1)</label
        ><input
          id="np-key"
          v-model="form.key"
          class="input uppercase"
          required
          maxlength="10"
          pattern="[A-Za-z][A-Za-z0-9]{1,9}"
          @input="form.keyTouched = true"
        />
      </div>
      <div>
        <label class="label" for="np-desc">Description</label
        ><textarea id="np-desc" v-model="form.description" class="input" rows="2"></textarea>
      </div>
      <div><label class="label">Lead</label><UserSelect v-model="form.leadId" :allow-none="false" /></div>
      <div>
        <label class="label" for="np-vis">Who can see it</label>
        <select id="np-vis" v-model="form.visibility" class="input">
          <option value="open">Everyone in the workspace</option>
          <option value="private">Project members only</option>
        </select>
      </div>
      <p v-if="error" class="text-sm text-red-700">{{ error }}</p>
    </form>
    <template #footer>
      <template v-if="created"
        ><button
          class="btn btn-primary"
          @click="
            creating = false;
            router.push(`/projects/${created.key}/board`);
          "
        >
          Open the board
        </button></template
      >
      <template v-else
        ><button class="btn" @click="creating = false">Cancel</button
        ><button class="btn btn-primary" form="new-project">Create project</button></template
      >
    </template>
  </Modal>
</template>
