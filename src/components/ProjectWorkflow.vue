<script setup>
// Project settings > Workflow rules: allowed moves, values required on entering a status, and automations.
// API: GET/PUT /api/projects/:key/workflow (server/lib/workflow.js).
import { ref, reactive, computed, onMounted, watch } from 'vue';
import { get, put, toast } from '../api.js';
import UserSelect from './UserSelect.vue';
import FieldInput from './FieldInput.vue';
import { attempt } from '../composables/useAction.js';

const props = defineProps({ project: { type: Object, required: true } });
const emit = defineEmits(['changed']);
const loaded = ref(false);
const saving = ref(false);
const requirable = ref({});
const m = reactive({ limit: false, allowed: {}, adminBypass: true, rules: {} });
const editing = ref('');
const statuses = computed(() => props.project.statuses);
const fields = computed(() => (props.project.fields || []).filter((f) => !f.archived));
const nameOf = (id) => statuses.value.find((s) => s.id === id)?.name || '';

const blankRule = () => ({
  required: [],
  assignee: '',
  userId: null,
  addLabels: '',
  removeLabels: '',
  fieldId: '',
  fieldValue: null,
  comment: '',
  sprint: '',
  notify: '',
});
function ruleFor(id) {
  if (!m.rules[id]) m.rules[id] = blankRule();
  return m.rules[id];
}

async function load() {
  const r = await get(`/api/projects/${props.project.key}/workflow`);
  requirable.value = r.requirable;
  const w = r.workflow;
  m.limit = Boolean(w.transitions);
  m.adminBypass = w.adminBypass;
  m.allowed = {};
  for (const from of statuses.value) {
    const list = w.transitions?.[from.id];
    m.allowed[from.id] = Object.fromEntries(
      statuses.value.filter((t) => t.id !== from.id).map((t) => [t.id, !Array.isArray(list) || list.includes(t.id)]),
    );
  }
  m.rules = {};
  for (const [id, rule] of Object.entries(w.statuses || {})) {
    const a = rule.actions || {};
    m.rules[id] = {
      required: [...(rule.required || [])],
      assignee: a.assignee?.to || '',
      userId: a.assignee?.userId || null,
      addLabels: (a.addLabels || []).join(', '),
      removeLabels: (a.removeLabels || []).join(', '),
      fieldId: a.field?.fieldId || '',
      fieldValue: a.field?.value ?? null,
      comment: a.comment || '',
      sprint: a.sprint || '',
      notify: a.notify || '',
    };
  }
  editing.value = editing.value || statuses.value[statuses.value.length - 1]?.id || '';
  if (editing.value) ruleFor(editing.value);
  loaded.value = true;
}
onMounted(() => load().catch((e) => toast(e.message, 'error')));

const labelList = (text) =>
  String(text || '')
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);
const ruleCount = (id) => {
  const r = m.rules[id];
  if (!r) return 0;
  return (
    r.required.length +
    [
      r.assignee,
      labelList(r.addLabels).length,
      labelList(r.removeLabels).length,
      r.fieldId,
      r.comment.trim(),
      r.sprint,
      r.notify.trim(),
    ].filter(Boolean).length
  );
};
watch(editing, (id) => {
  if (id) ruleFor(id);
});
const rule = computed(() => m.rules[editing.value]);
const chosenField = computed(() => fields.value.find((f) => f.id === rule.value?.fieldId));

function setAll(value) {
  for (const from of Object.keys(m.allowed)) for (const to of Object.keys(m.allowed[from])) m.allowed[from][to] = value;
}

async function save() {
  const body = { adminBypass: m.adminBypass, transitions: null, statuses: {} };
  if (m.limit) {
    body.transitions = {};
    for (const from of statuses.value)
      body.transitions[from.id] = Object.entries(m.allowed[from.id] || {})
        .filter(([, ok]) => ok)
        .map(([to]) => to);
  }
  for (const [id, r] of Object.entries(m.rules)) {
    const actions = {};
    if (r.assignee) actions.assignee = { to: r.assignee, ...(r.assignee === 'user' ? { userId: r.userId } : {}) };
    if (labelList(r.addLabels).length) actions.addLabels = labelList(r.addLabels);
    if (labelList(r.removeLabels).length) actions.removeLabels = labelList(r.removeLabels);
    if (r.fieldId) actions.field = { fieldId: r.fieldId, value: r.fieldValue };
    if (r.comment.trim()) actions.comment = r.comment.trim();
    if (r.sprint) actions.sprint = r.sprint;
    if (r.notify.trim()) actions.notify = r.notify.trim();
    if (r.required.length || Object.keys(actions).length) body.statuses[id] = { required: r.required, actions };
  }
  if (Object.values(body.statuses).some((x) => x.actions.assignee?.to === 'user' && !x.actions.assignee.userId))
    return toast('Choose the person to assign', 'error');
  saving.value = true;
  await attempt(async () => {
    await put(`/api/projects/${props.project.key}/workflow`, body);
    toast('Workflow rules saved');
    emit('changed');
  });
  saving.value = false;
}
</script>

<template>
  <form class="card space-y-4 p-4" @submit.prevent="save">
    <div>
      <h2 class="text-sm font-semibold">Workflow rules</h2>
      <p class="text-xs text-slate-500">
        Limit which statuses an issue can move to, ask for values before an issue enters a status, and change the issue automatically when
        it does. The rules apply on the board, the status select, bulk changes and AI connectors.
      </p>
    </div>
    <p v-if="!loaded" class="text-sm text-slate-500">Loading</p>
    <template v-else>
      <section class="space-y-2">
        <h3 class="text-xs font-semibold uppercase text-slate-600">Allowed moves</h3>
        <label class="flex items-center gap-2 text-sm"
          ><input v-model="m.limit" type="checkbox" /> Limit which statuses an issue can move to</label
        >
        <div v-if="m.limit" class="space-y-2">
          <div class="overflow-x-auto">
            <table class="text-sm">
              <caption class="sr-only">
                Allowed moves: rows are the current status, columns the new status
              </caption>
              <thead>
                <tr>
                  <th scope="col" class="px-2 py-1 text-left text-xs font-semibold text-slate-600">From \ To</th>
                  <th v-for="t in statuses" :key="t.id" scope="col" class="px-2 py-1 text-xs font-semibold text-slate-600">{{ t.name }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="f in statuses" :key="f.id" class="border-t border-slate-100">
                  <th scope="row" class="whitespace-nowrap px-2 py-1 text-left font-medium">{{ f.name }}</th>
                  <td v-for="t in statuses" :key="t.id" class="px-2 py-1 text-center">
                    <span v-if="t.id === f.id" class="text-slate-400" aria-hidden="true">-</span>
                    <input
                      v-else
                      v-model="m.allowed[f.id][t.id]"
                      type="checkbox"
                      :aria-label="`Allow moving from ${f.name} to ${t.name}`"
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="flex flex-wrap gap-2">
            <button type="button" class="btn btn-sm" @click="setAll(true)">Allow all</button
            ><button type="button" class="btn btn-sm" @click="setAll(false)">Clear all</button>
          </div>
          <p class="text-xs text-slate-500">A new status starts with no moves into it; tick it here after adding it.</p>
        </div>
        <label class="flex items-center gap-2 text-sm"
          ><input v-model="m.adminBypass" type="checkbox" /> Admins can move issues anywhere</label
        >
      </section>

      <section class="space-y-3">
        <h3 class="text-xs font-semibold uppercase text-slate-600">When an issue enters a status</h3>
        <div class="flex flex-wrap gap-1" role="group" aria-label="Status to edit">
          <button
            v-for="s in statuses"
            :key="s.id"
            type="button"
            class="chip border"
            :class="
              editing === s.id ? 'border-black bg-black text-white' : 'border-slate-300 bg-white text-slate-700 hover:border-slate-500'
            "
            :aria-pressed="editing === s.id"
            @click="editing = s.id"
          >
            {{ s.name }}<span v-if="ruleCount(s.id)" class="ml-1 rounded-full bg-accent px-1.5 text-white">{{ ruleCount(s.id) }}</span>
          </button>
        </div>
        <div v-if="editing && rule" class="grid gap-4 md:grid-cols-2">
          <fieldset class="space-y-1">
            <legend class="label">{{ nameOf(editing) }} needs</legend>
            <label v-for="(label, key) in requirable" :key="key" class="flex items-center gap-2 text-sm"
              ><input v-model="rule.required" type="checkbox" :value="key" /> {{ label }}</label
            >
            <label v-for="f in fields" :key="f.id" class="flex items-center gap-2 text-sm"
              ><input v-model="rule.required" type="checkbox" :value="'cf:' + f.id" /> {{ f.name }}</label
            >
            <p class="text-xs text-slate-500">
              People are asked for missing values when they move an issue on the board or with the status select.
            </p>
          </fieldset>
          <div class="space-y-2">
            <div class="label">Then change the issue</div>
            <div>
              <label class="label" for="wf-assignee">Assignee</label>
              <select id="wf-assignee" v-model="rule.assignee" class="input">
                <option value="">Do not change</option>
                <option value="user">A person</option>
                <option value="reporter">The reporter</option>
                <option value="actor">The person who moves it</option>
                <option value="clear">Nobody (unassign)</option>
              </select>
            </div>
            <div v-if="rule.assignee === 'user'">
              <span class="label">Person</span><UserSelect v-model="rule.userId" :allow-none="false" placeholder="Choose a person" />
            </div>
            <div class="grid gap-2 sm:grid-cols-2">
              <div>
                <label class="label" for="wf-add">Add labels</label
                ><input id="wf-add" v-model="rule.addLabels" class="input" placeholder="e.g. qa, ready" />
              </div>
              <div>
                <label class="label" for="wf-remove">Remove labels</label
                ><input id="wf-remove" v-model="rule.removeLabels" class="input" placeholder="e.g. wip" />
              </div>
            </div>
            <div v-if="fields.length" class="grid gap-2 sm:grid-cols-2">
              <div>
                <label class="label" for="wf-field">Set a custom field</label>
                <select id="wf-field" v-model="rule.fieldId" class="input" @change="rule.fieldValue = null">
                  <option value="">None</option>
                  <option v-for="f in fields" :key="f.id" :value="f.id">{{ f.name }}</option>
                </select>
              </div>
              <div v-if="chosenField">
                <label class="label" for="wf-field-value">Value</label
                ><FieldInput id="wf-field-value" v-model="rule.fieldValue" :field="chosenField" />
              </div>
            </div>
            <div>
              <label class="label" for="wf-sprint">Sprint</label>
              <select id="wf-sprint" v-model="rule.sprint" class="input">
                <option value="">Do not change</option>
                <option value="active">Move to the active sprint</option>
                <option value="backlog">Move to the backlog</option>
              </select>
            </div>
            <div>
              <label class="label" for="wf-comment">Add a comment</label
              ><textarea
                id="wf-comment"
                v-model="rule.comment"
                class="input"
                rows="2"
                maxlength="2000"
                placeholder="e.g. {user} moved this to {status}."
              ></textarea>
            </div>
            <div>
              <label class="label" for="wf-notify">Message to watchers</label
              ><input id="wf-notify" v-model="rule.notify" class="input" maxlength="500" placeholder="e.g. {key} is ready for review" />
            </div>
            <p class="text-xs text-slate-500">
              You can use {user}, {status}, {key} and {title}. The comment is added in the name of the person who moves the issue. The
              message replaces the usual "moved to" notice. Automations never start other automations.
            </p>
          </div>
        </div>
      </section>
      <button class="btn btn-primary" :disabled="saving">Save workflow rules</button>
    </template>
  </form>
</template>
