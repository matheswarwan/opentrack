<script setup>
// Admin > Templates: every saved project template (built-ins are part of the app and cannot be deleted).
import { get, patch, del, toast } from '../../api.js';
import { ago } from '../../meta.js';
import { templateParts, joinParts } from '../../projectTemplates.js';
import { attempt } from '../../composables/useAction.js';
import { useLoad } from '../../composables/useLoad.js';
import LoadState from '../../components/LoadState.vue';

const {
  data: templates,
  loading,
  error: loadError,
  reload: load,
} = useLoad(async () => (await get('/api/project-templates?all=1')).templates, null, { initial: [] });
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
  <p class="mb-3 max-w-3xl text-sm text-slate-600">
    Project templates saved from existing projects (Project settings &gt; Save as template). The four built-in templates (Salesforce
    implementation, Marketing Cloud build, Support and managed services, Internal project) are part of the app and always available.
  </p>
  <LoadState v-if="loading || loadError" :loading="loading" :error="loadError" card @retry="load" />
  <div v-else class="card overflow-x-auto">
    <table class="w-full text-sm">
      <thead class="bg-slate-50 text-left text-xs uppercase text-slate-500">
        <tr>
          <th class="px-3 py-2">Name</th>
          <th class="px-3 py-2">Saved by</th>
          <th class="px-3 py-2">Who can use it</th>
          <th class="px-3 py-2">Updated</th>
          <th class="px-3 py-2"><span class="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="t in templates" :key="t.id" class="border-t border-slate-100 align-top">
          <td class="px-3 py-2">
            <div class="font-medium">{{ t.name }}</div>
            <div v-if="t.description" class="text-xs text-slate-600">{{ t.description }}</div>
            <div class="text-xs text-slate-500">
              {{ t.summary ? joinParts(templateParts(t.summary)) : 'This template cannot be read. Delete it.' }}
            </div>
          </td>
          <td class="px-3 py-2">{{ t.owner?.name || 'Former user' }}</td>
          <td class="px-3 py-2">{{ t.visibility === 'shared' ? 'Everyone (not guests)' : 'Only the person who saved it' }}</td>
          <td class="whitespace-nowrap px-3 py-2 text-slate-600">{{ ago(t.updatedAt) }}</td>
          <td class="whitespace-nowrap px-3 py-2 text-right">
            <button class="btn btn-sm" :aria-label="(t.visibility === 'shared' ? 'Make private ' : 'Share ') + t.name" @click="share(t)">
              {{ t.visibility === 'shared' ? 'Make private' : 'Share' }}
            </button>
            <button class="btn btn-sm btn-danger ml-1" :aria-label="'Delete ' + t.name" @click="remove(t)">Delete</button>
          </td>
        </tr>
        <tr v-if="!templates.length">
          <td colspan="5" class="px-3 py-8 text-center text-slate-500">No saved templates yet.</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
