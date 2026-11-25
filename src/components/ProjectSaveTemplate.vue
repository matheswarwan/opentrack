<script setup>
// Project settings > Save as template: saves this project's structure as a project template (server/routes/projectTemplates.js).
import { ref, reactive, onMounted } from 'vue';
import { get, post, patch, del, toast, session } from '../api.js';
import { templateParts, joinParts } from '../projectTemplates.js';
import { attempt } from '../composables/useAction.js';

const props = defineProps({ projectKey: String, projectName: String });
const form = reactive({ name: '', description: '', visibility: 'private', includeIssues: false, keepRoles: false });
const saving = ref(false);
const mine = ref([]);
async function load() {
  try {
    mine.value = (await get('/api/project-templates')).templates.filter((t) => !t.builtin && t.owner?.id === session.user.id);
  } catch {
    mine.value = [];
  }
}
onMounted(load);
async function save() {
  saving.value = true;
  await attempt(async () => {
    const r = await post('/api/project-templates', { projectKey: props.projectKey, ...form, name: form.name || undefined });
    toast(`Template ${r.template.name} saved`);
    form.name = '';
    form.description = '';
    await load();
  });
  saving.value = false;
}
async function share(t) {
  await attempt(async () => {
    await patch(`/api/project-templates/${t.id}`, { visibility: t.visibility === 'shared' ? 'private' : 'shared' });
    await load();
  });
}
async function remove(t) {
  if (!confirm(`Delete the template ${t.name}? Projects made from it are not changed.`)) return;
  await attempt(async () => {
    await del(`/api/project-templates/${t.id}`);
    toast('Template deleted');
    await load();
  });
}
</script>
<template>
  <div class="card space-y-3 p-4">
    <h2 class="text-sm font-semibold">Save as template</h2>
    <p class="text-xs text-slate-500">
      Start new projects with this project's setup: statuses, workflow rules, fields, components, issue templates, recurring tasks,
      permissions and the labels in use. Comments, history and members are never saved.
    </p>
    <form class="space-y-3" @submit.prevent="save">
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="label" for="pst-name">Template name</label
          ><input id="pst-name" v-model="form.name" class="input" maxlength="80" :placeholder="`${projectName} template`" />
        </div>
        <div>
          <label class="label" for="pst-vis">Who can use it</label>
          <select id="pst-vis" v-model="form.visibility" class="input">
            <option value="private">Only me</option>
            <option value="shared">Everyone (not guests)</option>
          </select>
        </div>
        <div class="sm:col-span-2">
          <label class="label" for="pst-desc">Description</label
          ><input id="pst-desc" v-model="form.description" class="input" maxlength="500" placeholder="What kind of project it suits" />
        </div>
      </div>
      <label class="flex items-start gap-2 text-sm"
        ><input v-model="form.includeIssues" type="checkbox" class="mt-1" />
        <span
          >Include the open epics, stories and tasks as starter issues (due dates become "day N" counted from when this project was
          created)</span
        ></label
      >
      <label class="flex items-start gap-2 text-sm"
        ><input v-model="form.keepRoles" type="checkbox" class="mt-1" />
        <span
          >Keep default assignees by role: work assigned to the project lead goes to the new project's lead. Other people are left
          out.</span
        ></label
      >
      <button class="btn btn-primary" :disabled="saving">{{ saving ? 'Saving...' : 'Save as template' }}</button>
    </form>
    <div v-if="mine.length">
      <h3 class="label">Templates you saved</h3>
      <ul class="divide-y divide-slate-100 text-sm">
        <li v-for="t in mine" :key="t.id" class="flex flex-wrap items-center gap-2 py-1.5">
          <span class="min-w-0 flex-1"
            ><span class="font-medium">{{ t.name }}</span>
            <span class="block text-xs text-slate-500">{{ t.summary ? joinParts(templateParts(t.summary)) : 'Cannot be read' }}</span></span
          >
          <span class="chip bg-slate-100 text-slate-600">{{ t.visibility === 'shared' ? 'Shared' : 'Only me' }}</span>
          <button class="btn btn-sm" :aria-label="(t.visibility === 'shared' ? 'Stop sharing ' : 'Share ') + t.name" @click="share(t)">
            {{ t.visibility === 'shared' ? 'Stop sharing' : 'Share' }}
          </button>
          <button class="btn btn-sm btn-danger" :aria-label="'Delete ' + t.name" @click="remove(t)">Delete</button>
        </li>
      </ul>
    </div>
  </div>
</template>
