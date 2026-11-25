<script setup>
// Project settings > Components (project admins): name, description, lead and default assignee.
import { ref, watch } from 'vue';
import { del, toast } from '../api.js';
import UserSelect from './UserSelect.vue';
import { useCrud } from '../composables/useCrud.js';
import { plural } from '../plural.js';

const props = defineProps({ projectKey: { type: String, required: true } });
const emit = defineEmits(['changed']);
const removing = ref(null); // { component, moveTo }
const base = () => `/api/projects/${props.projectKey}/components`;
const {
  items: components,
  editing,
  form,
  busy,
  run,
  load,
  edit,
  save,
} = useCrud({
  base,
  list: (r) => r.components,
  blank: (c) => ({
    name: c?.name || '',
    description: c?.description || '',
    leadId: c?.lead?.id || null,
    defaultAssigneeId: c?.defaultAssignee?.id || null,
  }),
  saved: 'Component saved',
  changed: () => emit('changed'),
});
watch(() => props.projectKey, load, { immediate: true });

// its own delete: a dialog that can move the issues to another component first
function remove() {
  const { component, moveTo } = removing.value;
  return run(async () => {
    await del(`${base()}/${component.id}${moveTo ? `?moveTo=${encodeURIComponent(moveTo)}` : ''}`);
    toast(`Deleted ${component.name}`);
    removing.value = null;
    await load();
    emit('changed');
  });
}
</script>

<template>
  <div class="card p-4">
    <div class="mb-2 flex flex-wrap items-center gap-2">
      <h2 class="text-sm font-semibold">Components</h2>
      <button class="btn btn-sm btn-primary ml-auto" :disabled="busy" @click="edit(null)">New component</button>
    </div>
    <p class="mb-2 text-xs text-slate-500">
      Parts of the product, like UI or API. An issue can be in several components. When an issue without an assignee gets a component with a
      default assignee, that person is assigned.
    </p>

    <div v-for="c in components" :key="c.id" class="flex flex-wrap items-center gap-2 border-b border-slate-100 py-1.5 text-sm">
      <span class="min-w-0 flex-1">
        <RouterLink :to="`/projects/${projectKey}/issues?component=${c.id}`" class="font-semibold hover:underline">{{ c.name }}</RouterLink>
        <span class="text-xs text-slate-500">
          {{ c.openIssues }} open of {{ c.issues }}<template v-if="c.lead">, lead {{ c.lead.name }}</template
          ><template v-if="c.defaultAssignee">, assigns to {{ c.defaultAssignee.name }}</template></span
        >
        <span v-if="c.description" class="block truncate text-xs text-slate-500">{{ c.description }}</span>
      </span>
      <button class="btn btn-sm btn-ghost" @click="edit(c)">Edit</button>
      <button class="text-slate-400 hover:text-red-700" :aria-label="'Delete ' + c.name" @click="removing = { component: c, moveTo: '' }">
        ×
      </button>
    </div>
    <p v-if="!components.length && !editing" class="py-2 text-sm text-slate-500">No components yet.</p>

    <form v-if="removing" class="mt-3 space-y-2 rounded-md bg-red-50 p-3 text-sm" @submit.prevent="remove">
      <p>
        Delete <strong>{{ removing.component.name }}</strong>? It is taken off {{ removing.component.issues }}
        {{ plural(removing.component.issues, 'issue') }}.
      </p>
      <label v-if="removing.component.issues && components.length > 1" class="block"
        ><span class="label">Move its issues to</span>
        <select v-model="removing.moveTo" class="input">
          <option value="">No component</option>
          <option v-for="o in components.filter((x) => x.id !== removing.component.id)" :key="o.id" :value="o.id">{{ o.name }}</option>
        </select></label
      >
      <div class="flex gap-2">
        <button class="btn btn-sm btn-danger" :disabled="busy">Delete</button
        ><button type="button" class="btn btn-sm" @click="removing = null">Cancel</button>
      </div>
    </form>

    <form v-if="editing" class="mt-3 grid gap-3 rounded-md bg-slate-50 p-3 sm:grid-cols-2" @submit.prevent="save">
      <div>
        <label class="label" for="cp-name">Name</label
        ><input id="cp-name" v-model="form.name" class="input" maxlength="80" required placeholder="e.g. Checkout" />
      </div>
      <div>
        <label class="label" for="cp-desc">Description</label
        ><input id="cp-desc" v-model="form.description" class="input" maxlength="1000" />
      </div>
      <div><span class="label">Lead</span><UserSelect v-model="form.leadId" placeholder="No lead" /></div>
      <div><span class="label">Default assignee</span><UserSelect v-model="form.defaultAssigneeId" placeholder="None" /></div>
      <div class="flex gap-2 sm:col-span-2">
        <button class="btn btn-primary" :disabled="busy">Save component</button
        ><button type="button" class="btn" @click="editing = null">Cancel</button>
      </div>
    </form>
  </div>
</template>
