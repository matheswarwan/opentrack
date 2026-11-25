<script setup>
// Project settings > Fields: custom fields for this project's issues (project admins).
import { ref, watch, computed } from 'vue';
import { patch, toast } from '../api.js';
import { TYPES } from '../meta.js';
import { FIELD_TYPES, fieldTypeLabel } from '../fields.js';
import { attempt } from '../composables/useAction.js';
import { useCrud } from '../composables/useCrud.js';

const props = defineProps({ projectKey: { type: String, required: true } });
const emit = defineEmits(['changed']);
const showArchived = ref(false);
const base = () => `/api/projects/${props.projectKey}/fields`;
const crud = useCrud({
  base,
  list: (r) => r.fields,
  blank: (f) => ({
    name: f?.name || '',
    type: f?.type || 'text',
    help: f?.help || '',
    required: Boolean(f?.required),
    issueTypes: [...(f?.issueTypes || [])],
    options: (f?.options || []).map((o) => ({ ...o })),
    newOption: '',
  }),
  // the type is only sent for a new field: it cannot be changed afterwards
  body: (isNew) => ({
    name: form.name,
    help: form.help,
    required: form.required,
    issueTypes: form.issueTypes,
    ...(hasOptions.value
      ? { options: form.options.map((o) => ({ ...(o.id ? { id: o.id } : {}), name: o.name, archived: o.archived })) }
      : {}),
    ...(isNew ? { type: form.type } : {}),
  }),
  saved: 'Field saved',
  changed: () => emit('changed'),
});
const { items: fields, editing, form, busy, load, edit } = crud;
watch(() => props.projectKey, load, { immediate: true });
const listed = computed(() => fields.value.filter((f) => showArchived.value || !f.archived));
const hasOptions = computed(() => form.type === 'select' || form.type === 'multiselect');

function addOption() {
  const name = form.newOption.trim();
  if (!name) return;
  if (form.options.some((o) => o.name.toLowerCase() === name.toLowerCase())) {
    toast('That option is already there', 'error');
    return;
  }
  form.options.push({ name, archived: false });
  form.newOption = '';
}
function moveOption(i, dir) {
  const j = i + dir;
  [form.options[i], form.options[j]] = [form.options[j], form.options[i]];
}
function removeOption(i) {
  // options in use keep their id: removing a saved one archives it instead
  if (form.options[i].id) form.options[i].archived = true;
  else form.options.splice(i, 1);
}

function save() {
  if (hasOptions.value) addOption(); // an option typed but not added yet counts
  return crud.save();
}
async function setArchived(f, archived) {
  await attempt(async () => {
    await patch(`${base()}/${f.id}`, { archived });
    await load();
    emit('changed');
  });
}
const remove = (f) => crud.remove(f, `Delete the field "${f.name}" and its value on every issue? Archive it instead to keep the values.`);
async function move(i, dir) {
  const list = [...listed.value];
  const j = i + dir;
  [list[i], list[j]] = [list[j], list[i]];
  await attempt(async () => {
    await Promise.all(list.map((f, k) => (f.position === k ? null : patch(`${base()}/${f.id}`, { position: k }))));
    await load();
    emit('changed');
  });
}
const typesText = (f) =>
  f.issueTypes.length ? f.issueTypes.map((t) => TYPES.find((x) => x.id === t)?.label || t).join(', ') : 'All types';
</script>

<template>
  <div class="card p-4">
    <div class="mb-2 flex flex-wrap items-center gap-2">
      <h2 class="text-sm font-semibold">Fields</h2>
      <div class="ml-auto flex flex-wrap items-center gap-2">
        <label v-if="fields.some((f) => f.archived)" class="flex items-center gap-1 text-xs text-slate-600"
          ><input v-model="showArchived" type="checkbox" /> Show archived</label
        >
        <button class="btn btn-sm btn-primary" :disabled="busy" @click="edit(null)">New field</button>
      </div>
    </div>
    <p class="mb-2 text-xs text-slate-500">
      Extra fields for this project's issues. They show in the issue panel and the Create issue dialog, and work in search, exports, Google
      Sheets feeds, imports, templates and reports. A required field is needed on new issues only.
    </p>

    <div v-for="(f, i) in listed" :key="f.id" class="flex flex-wrap items-center gap-2 border-b border-slate-100 py-1.5 text-sm">
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
          :disabled="i === listed.length - 1"
          aria-label="Move down"
          @click="move(i, 1)"
        >
          ▼
        </button>
      </div>
      <span class="min-w-0 flex-1"
        ><strong :class="f.archived ? 'text-slate-400' : ''">{{ f.name }}</strong>
        <span class="text-xs text-slate-500">
          {{ fieldTypeLabel(f.type) }}, {{ typesText(f) }}<template v-if="f.required">, required</template
          ><template v-if="f.archived">, archived</template></span
        ></span
      >
      <button class="btn btn-sm btn-ghost" @click="edit(f)">Edit</button>
      <button class="btn btn-sm btn-ghost" @click="setArchived(f, !f.archived)">{{ f.archived ? 'Restore' : 'Archive' }}</button>
      <button class="text-slate-400 hover:text-red-700" :aria-label="'Delete ' + f.name" @click="remove(f)">×</button>
    </div>
    <p v-if="!fields.length && !editing" class="py-2 text-sm text-slate-500">No fields yet.</p>

    <form v-if="editing" class="mt-3 grid gap-3 rounded-md bg-slate-50 p-3 sm:grid-cols-2" @submit.prevent="save">
      <div>
        <label class="label" for="cf-name">Name</label
        ><input id="cf-name" v-model="form.name" class="input" maxlength="60" required placeholder="e.g. Customer" />
      </div>
      <div>
        <label class="label" for="cf-type">Type</label>
        <select id="cf-type" v-model="form.type" class="input" :disabled="editing !== 'new'">
          <option v-for="t in FIELD_TYPES" :key="t.id" :value="t.id">{{ t.label }}</option>
        </select>
        <p v-if="editing !== 'new'" class="mt-1 text-xs text-slate-500">The type cannot be changed.</p>
      </div>
      <div class="sm:col-span-2">
        <label class="label" for="cf-help">Help text</label
        ><input id="cf-help" v-model="form.help" class="input" maxlength="300" placeholder="Shown with the field" />
      </div>
      <div class="sm:col-span-2">
        <span class="label">Issue types</span>
        <div class="flex flex-wrap gap-3 text-sm">
          <label v-for="t in TYPES" :key="t.id" class="flex items-center gap-1"
            ><input v-model="form.issueTypes" type="checkbox" :value="t.id" />{{ t.label }}</label
          >
        </div>
        <p class="mt-1 text-xs text-slate-500">None ticked: every type.</p>
      </div>
      <label class="flex items-center gap-2 text-sm sm:col-span-2"
        ><input v-model="form.required" type="checkbox" /> Required on new issues</label
      >
      <div v-if="hasOptions" class="sm:col-span-2">
        <span class="label">Options</span>
        <div
          v-for="(o, i) in form.options"
          :key="o.id || 'new' + i"
          class="flex items-center gap-2 py-0.5"
          :class="o.archived ? 'opacity-60' : ''"
        >
          <div class="flex flex-col">
            <button
              type="button"
              class="text-xs leading-none text-slate-400 hover:text-slate-800 disabled:opacity-30"
              :disabled="i === 0"
              aria-label="Move option up"
              @click="moveOption(i, -1)"
            >
              ▲</button
            ><button
              type="button"
              class="text-xs leading-none text-slate-400 hover:text-slate-800 disabled:opacity-30"
              :disabled="i === form.options.length - 1"
              aria-label="Move option down"
              @click="moveOption(i, 1)"
            >
              ▼
            </button>
          </div>
          <input v-model="o.name" class="input py-1" maxlength="80" :aria-label="'Option ' + (i + 1)" required />
          <button v-if="o.archived" type="button" class="btn btn-sm btn-ghost" @click="o.archived = false">Restore</button>
          <button
            v-else
            type="button"
            class="btn btn-sm btn-ghost"
            :title="o.id ? 'Archived options stay on issues that have them' : ''"
            @click="removeOption(i)"
          >
            {{ o.id ? 'Archive' : 'Remove' }}
          </button>
        </div>
        <div class="mt-1 flex gap-2">
          <input
            v-model="form.newOption"
            class="input py-1"
            maxlength="80"
            placeholder="New option"
            @keydown.enter.prevent="addOption"
          /><button type="button" class="btn btn-sm" @click="addOption">Add</button>
        </div>
        <p class="mt-1 text-xs text-slate-500">Renaming an option keeps it on the issues that have it.</p>
      </div>
      <div class="flex gap-2 sm:col-span-2">
        <button class="btn btn-primary" :disabled="busy">Save field</button
        ><button type="button" class="btn" @click="editing = null">Cancel</button>
      </div>
    </form>
  </div>
</template>
