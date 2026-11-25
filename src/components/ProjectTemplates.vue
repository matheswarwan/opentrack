<script setup>
// Project settings > Templates: issue templates for the Create issue dialog (project admins).
import { ref, watch } from 'vue';
import { get, post, patch, toast } from '../api.js';
import { TYPES, PRIORITIES, typeOf } from '../meta.js';
import LabelsInput from './LabelsInput.vue';
import MarkdownEditor from './MarkdownEditor.vue';
import FieldInput from './FieldInput.vue';
import { activeFields, appliesTo } from '../fields.js';
import MultiPick from './MultiPick.vue';
import { attempt } from '../composables/useAction.js';
import { useCrud } from '../composables/useCrud.js';

const props = defineProps({ projectKey: { type: String, required: true } });
const base = () => `/api/projects/${props.projectKey}/templates`;
const canHaveSubtasks = (type) => ['story', 'task', 'bug'].includes(type);

const fields = ref([]); // custom fields: a template can hold default values
const components = ref([]); // a template can add default components
// what the form offers; loaded after the templates, also when those did not arrive
async function loadFormLists() {
  try {
    fields.value = activeFields((await get(`/api/projects/${props.projectKey}/fields`)).fields);
  } catch {
    fields.value = [];
  }
  try {
    components.value = (await get(`/api/projects/${props.projectKey}/components`)).components.map((c) => ({ id: c.id, name: c.name }));
  } catch {
    components.value = [];
  }
}
const crud = useCrud({
  base,
  list: (r) => r.templates,
  blank: (t) => ({
    name: t?.name || '',
    type: t?.type || 'task',
    titlePrefix: t?.titlePrefix || '',
    priority: t?.priority || '',
    labels: [...(t?.labels || [])],
    description: t?.description || '',
    subtasks: (t?.subtasks || []).join('\n'),
    fields: { ...(t?.fields || {}) },
    components: [...(t?.components || [])],
  }),
  body: () => ({
    ...form,
    priority: form.priority || null,
    subtasks: canHaveSubtasks(form.type)
      ? form.subtasks
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
    fields: Object.fromEntries(
      Object.entries(form.fields).filter(([id, v]) => {
        const f = fields.value.find((x) => x.id === id);
        return f && appliesTo(f, form.type) && v !== null && v !== '' && !(Array.isArray(v) && !v.length);
      }),
    ),
  }),
  saved: 'Template saved',
  changed: loadFormLists,
});
const { items: templates, editing, form, busy, run, edit, save } = crud;
async function load() {
  await crud.load();
  await loadFormLists();
}
watch(() => props.projectKey, load, { immediate: true });

const remove = (t) => crud.remove(t, `Delete the template "${t.name}"? Issues made from it are not changed.`);
const addStandard = () =>
  run(async () => {
    const r = await post(`${base()}/standard`);
    templates.value = r.templates;
    toast(r.added.length ? `Added ${r.added.join(', ')}` : 'The standard templates are already here');
  });
async function move(i, dir) {
  const list = [...templates.value];
  const j = i + dir;
  [list[i], list[j]] = [list[j], list[i]];
  await attempt(async () => {
    await Promise.all(list.map((t, k) => (t.position === k ? null : patch(`${base()}/${t.id}`, { position: k }))));
    await load();
  });
}
</script>

<template>
  <div class="card p-4">
    <div class="mb-2 flex flex-wrap items-center gap-2">
      <h2 class="text-sm font-semibold">Templates</h2>
      <div class="ml-auto flex flex-wrap gap-2">
        <button class="btn btn-sm" :disabled="busy" @click="addStandard">Add the standard set</button>
        <button class="btn btn-sm btn-primary" :disabled="busy" @click="edit(null)">New template</button>
      </div>
    </div>
    <p class="mb-2 text-xs text-slate-500">
      Templates show up in the Create issue dialog for this project. Picking one fills the type, summary prefix, description, priority and
      labels, and adds its sub-tasks after the issue is created. The standard set is Bug report, Feature request and Task.
    </p>

    <div v-for="(t, i) in templates" :key="t.id" class="flex items-center gap-2 border-b border-slate-100 py-1.5 text-sm">
      <div class="flex flex-col">
        <button
          class="text-xs leading-none text-slate-400 hover:text-slate-800 disabled:opacity-30"
          :disabled="i === 0"
          aria-label="Move up"
          @click="move(i, -1)"
        >
          ▲</button
        ><button
          class="text-xs leading-none text-slate-400 hover:text-slate-800 disabled:opacity-30"
          :disabled="i === templates.length - 1"
          aria-label="Move down"
          @click="move(i, 1)"
        >
          ▼
        </button>
      </div>
      <span class="min-w-0 flex-1 truncate"
        ><strong>{{ t.name }}</strong>
        <span class="text-xs text-slate-500"
          >{{ typeOf(t.type).label }}<template v-if="t.titlePrefix">, "{{ t.titlePrefix }}"</template
          ><template v-if="t.subtasks.length">, {{ t.subtasks.length }} sub-tasks</template></span
        ></span
      >
      <button class="btn btn-sm btn-ghost" @click="edit(t)">Edit</button>
      <button class="text-slate-400 hover:text-red-700" :aria-label="'Delete ' + t.name" @click="remove(t)">×</button>
    </div>
    <p v-if="!templates.length && !editing" class="py-2 text-sm text-slate-500">No templates yet.</p>

    <form v-if="editing" class="mt-3 grid gap-3 rounded-md bg-slate-50 p-3 sm:grid-cols-2" @submit.prevent="save">
      <div>
        <label class="label" for="tp-name">Name</label
        ><input id="tp-name" v-model="form.name" class="input" maxlength="80" required placeholder="e.g. Bug report" />
      </div>
      <div>
        <label class="label" for="tp-type">Issue type</label>
        <select id="tp-type" v-model="form.type" class="input">
          <option v-for="t in TYPES" :key="t.id" :value="t.id">{{ t.label }}</option>
        </select>
      </div>
      <div>
        <label class="label" for="tp-prefix">Summary prefix</label
        ><input id="tp-prefix" v-model="form.titlePrefix" class="input" maxlength="100" placeholder='e.g. "[Bug] " or "Release {title}"' />
        <p class="mt-1 text-xs text-slate-500">Put before the summary. Use {title} to place the summary inside a pattern.</p>
      </div>
      <div>
        <label class="label" for="tp-priority">Priority</label>
        <select id="tp-priority" v-model="form.priority" class="input">
          <option value="">Leave as is</option>
          <option v-for="p in PRIORITIES" :key="p.id" :value="p.id">{{ p.label }}</option>
        </select>
      </div>
      <div class="sm:col-span-2"><label class="label">Labels</label><LabelsInput v-model="form.labels" /></div>
      <div class="sm:col-span-2">
        <label class="label">Description (Markdown)</label><MarkdownEditor v-model="form.description" :rows="6" />
      </div>
      <div v-if="fields.some((f) => appliesTo(f, form.type))" class="sm:col-span-2">
        <span class="label">Field defaults</span>
        <div class="grid gap-2 sm:grid-cols-2">
          <div v-for="f in fields.filter((x) => appliesTo(x, form.type))" :key="f.id">
            <label class="text-xs text-slate-600" :for="'tp-cf-' + f.id">{{ f.name }}</label>
            <FieldInput :id="'tp-cf-' + f.id" v-model="form.fields[f.id]" compact :field="f" />
          </div>
        </div>
      </div>
      <div v-if="components.length" class="sm:col-span-2">
        <span class="label">Components</span>
        <MultiPick v-model="form.components" :options="components" label="Components" placeholder="Add component" />
      </div>
      <div v-if="canHaveSubtasks(form.type)" class="sm:col-span-2">
        <label class="label" for="tp-subs">Sub-tasks to create (one per line)</label>
        <textarea id="tp-subs" v-model="form.subtasks" class="input" rows="3" placeholder="Write tests&#10;Update the docs"></textarea>
      </div>
      <p v-else class="text-xs text-slate-500 sm:col-span-2">Only story, task and bug templates can add sub-tasks.</p>
      <div class="flex gap-2 sm:col-span-2">
        <button class="btn btn-primary" :disabled="busy">Save template</button
        ><button type="button" class="btn" @click="editing = null">Cancel</button>
      </div>
    </form>
  </div>
</template>
