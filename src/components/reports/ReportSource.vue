<script setup>
// Report builder, step 1: where the issues come from (a saved filter, one project, or issues matching a few
// fields). The form is a v-model (v-model:form, a blankSourceForm() of src/reports.js): a change hands the parent a new
// form, it is never edited in place. src/reports.js turns that form into the report's source.
import { computed, reactive } from 'vue';
import { session } from '../../api.js';
import { TYPES, PRIORITIES } from '../../meta.js';
import { QUICK_KEYS } from '../../reports.js';

const form = defineModel('form', { type: Object, required: true });
defineProps({
  filters: { type: Array, default: () => [] },
  projects: { type: Array, default: () => [] },
  people: { type: Array, default: () => [] },
});

const field = (key) => computed({ get: () => form.value[key], set: (v) => (form.value = { ...form.value, [key]: v }) });
const filterId = field('filterId');
const projectKey = field('projectKey');
/** The "Issues matching" fields, each a v-model of one key of form.quick (reactive unwraps the computed refs). */
const quick = reactive(
  Object.fromEntries(
    QUICK_KEYS.map((k) => [
      k,
      computed({ get: () => form.value.quick[k], set: (v) => (form.value = { ...form.value, quick: { ...form.value.quick, [k]: v } }) }),
    ]),
  ),
);
const setMode = (mode) => (form.value = { ...form.value, mode });
</script>
<template>
  <section class="card space-y-3 p-4" aria-labelledby="b-source">
    <h2 id="b-source" class="font-semibold">1. Issues</h2>
    <div class="flex flex-wrap rounded-full border border-slate-300 p-0.5 text-xs" role="group" aria-label="Where the issues come from">
      <button
        v-for="m in [
          { id: 'filter', label: 'Saved filter' },
          { id: 'project', label: 'Project' },
          { id: 'matching', label: 'Issues matching' },
        ]"
        :key="m.id"
        type="button"
        class="flex-1 rounded-full px-2.5 py-1 font-medium"
        :class="form.mode === m.id ? 'bg-black text-white' : 'text-slate-600 hover:bg-slate-100'"
        :aria-pressed="form.mode === m.id"
        @click="setMode(m.id)"
      >
        {{ m.label }}
      </button>
    </div>
    <template v-if="form.mode === 'filter'">
      <label class="label" for="b-filter">Saved filter</label>
      <select id="b-filter" v-model="filterId" class="input">
        <option value="">Choose a filter</option>
        <option v-for="f in filters" :key="f.id" :value="f.id">
          {{ f.name }}{{ f.mine ? '' : ` (by ${f.ownerName})` }}{{ f.shared ? ', shared' : '' }}
        </option>
      </select>
      <p v-if="!filters.length" class="text-xs text-slate-500">
        You have no saved filters. Save one on the <RouterLink to="/issues" class="link">Issues</RouterLink> page.
      </p>
    </template>
    <template v-else-if="form.mode === 'project'">
      <label class="label" for="b-project">Project</label>
      <select id="b-project" v-model="projectKey" class="input">
        <option value="">All projects I can see</option>
        <option v-for="p in projects" :key="p.key" :value="p.key">{{ p.name }} ({{ p.key }})</option>
      </select>
    </template>
    <div v-else class="grid grid-cols-2 gap-2">
      <label class="col-span-2"
        ><span class="label">Project</span>
        <select v-model="quick.project" class="input">
          <option value="">Any</option>
          <option v-for="p in projects" :key="p.key" :value="p.key">{{ p.name }}</option>
        </select></label
      >
      <label
        ><span class="label">Status</span>
        <select v-model="quick.category" class="input">
          <option value="">Any</option>
          <option value="todo,in_progress">Open</option>
          <option value="todo">To do</option>
          <option value="in_progress">In progress</option>
          <option value="done">Done</option>
        </select></label
      >
      <label
        ><span class="label">Assignee</span>
        <select v-model="quick.assignee" class="input">
          <option value="">Anyone</option>
          <option value="me">Me ({{ session.user?.name }})</option>
          <option value="unassigned">Unassigned</option>
          <option v-for="u in people" :key="u.id" :value="u.id">{{ u.name }}</option>
        </select></label
      >
      <label
        ><span class="label">Type</span>
        <select v-model="quick.type" class="input">
          <option value="">Any</option>
          <option v-for="t in TYPES" :key="t.id" :value="t.id">{{ t.label }}</option>
        </select></label
      >
      <label
        ><span class="label">Priority</span>
        <select v-model="quick.priority" class="input">
          <option value="">Any</option>
          <option v-for="p in PRIORITIES" :key="p.id" :value="p.id">{{ p.label }}</option>
        </select></label
      >
      <label
        ><span class="label">Sprint</span>
        <select v-model="quick.sprint" class="input">
          <option value="">Any</option>
          <option value="active">Active sprints</option>
          <option value="open">Not in a closed sprint</option>
          <option value="backlog">Backlog</option>
        </select></label
      >
      <label
        ><span class="label">Due within</span>
        <select v-model="quick.dueWithinDays" class="input">
          <option value="">Any time</option>
          <option value="0">Today or overdue</option>
          <option value="7">7 days</option>
          <option value="14">14 days</option>
          <option value="30">30 days</option>
        </select></label
      >
      <label><span class="label">Label</span><input v-model.lazy="quick.label" class="input" placeholder="Any" maxlength="100" /></label>
      <label><span class="label">Text</span><input v-model.lazy="quick.q" class="input" placeholder="Any" maxlength="200" /></label>
      <p v-if="Object.keys(form.extraQuery).length" class="col-span-2 text-xs text-slate-500">
        Also keeps conditions set elsewhere: {{ Object.keys(form.extraQuery).join(', ') }}.
      </p>
    </div>
  </section>
</template>
