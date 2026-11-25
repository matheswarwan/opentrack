<script setup>
import { ref, reactive, watch, onMounted, onBeforeUnmount, computed, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { get, post, del, qs, toast, users as loadUsers } from '../api.js';
import { ui, openIssue } from '../ui.js';
import { TYPES, PRIORITIES, CATEGORIES, fmtDate, ago } from '../meta.js';
import { today, addDays } from '../dates.js';
import TypeIcon from './TypeIcon.vue';
import PriorityIcon from './PriorityIcon.vue';
import StatusBadge from './StatusBadge.vue';
import Avatar from './Avatar.vue';
import SheetsFeed from './SheetsFeed.vue';
import UserSelect from './UserSelect.vue';
import Icon from './Icon.vue';
import BulkBar from './BulkBar.vue';
import BlockedBadge from './BlockedBadge.vue';
import FieldFilters from './FieldFilters.vue';
import { activeFields } from '../fields.js';
import { recentProjectKeys } from '../recent.js';
import { issuesDefaultProject, issuesScope, rememberIssuesScope } from '../projectSwitch.js';
import { useLoad } from '../composables/useLoad.js';
import { updateIssue } from '../issues.js';
import { projectList, project as fetchProject } from '../projects.js';
import StatusSelect from './StatusSelect.vue';
import LoadState from './LoadState.vue';
import { attempt } from '../composables/useAction.js';

// The issue search: filters, saved filters, the result table with inline and bulk editing. Used by the Issues page
// (every project, with a project filter) and by a project's Issues tab (that project only).
const props = defineProps({ project: { type: Object, default: null } }); // the one project to search in; null: all projects
const route = useRoute();
const router = useRouter();
const KEYS = [
  'q',
  'project',
  'type',
  'category',
  'statusName',
  'priority',
  'assignee',
  'reporter',
  'label',
  'sprint',
  'parent',
  'sort',
  'dir',
  'watching',
  'dueBefore',
  'updatedSince',
  'blocked',
  'component',
  'fixVersion',
];
const f = reactive({});
// custom field filters: dynamic keys cf.<fieldId> and cf.<fieldId>.empty (shown when one project is selected)
const cf = ref({});
const isCf = (k) => k.startsWith('cf.');
const cfOf = (q) =>
  Object.fromEntries(
    Object.entries(q || {})
      .filter(([k, v]) => isCf(k) && v !== '' && v !== undefined)
      .map(([k, v]) => [k, String(v)]),
  );
const page = ref(0);
const projects = ref([]);
const people = ref([]);
const filters = ref([]);
const saving = ref(null);
const PAGE = 50;

function fromRoute() {
  for (const k of KEYS) f[k] = route.query[k] ? String(route.query[k]) : '';
  cf.value = cfOf(route.query);
  if (props.project) f.project = props.project.key;
  if (!f.sort) f.sort = 'updated';
  page.value = Number(route.query.page || 0);
}
const cursor = ref(-1); // keyboard row
const selected = ref({}); // bulk selection: issue key -> project key (declared before the immediate watch below)
let lastFilters = '';
// the filters as the API takes them: 'all' (All projects picked) is no project filter
const apiF = () => ({ ...f, project: f.project === 'all' ? '' : f.project });
// manual: the route watch below reads the filters from the URL first, then calls load()
const {
  data: result,
  loading,
  error: loadError,
  reload: load,
} = useLoad(
  async () => {
    const sig = qs({ ...f, ...cf.value, sort: '', dir: '' }); // a new search clears the selection; paging and sorting keep it
    if (sig !== lastFilters) {
      lastFilters = sig;
      clearSelection();
    }
    const r = await get(`/api/issues?${qs({ ...apiF(), ...cf.value, limit: PAGE, offset: page.value * PAGE })}`);
    if (cursor.value >= r.issues.length) cursor.value = -1;
    return r;
  },
  null,
  { initial: { issues: [], total: 0 }, manual: true },
);
// the pickers of the filter bar
onMounted(() =>
  attempt(async () => {
    [projects.value, people.value, filters.value] = await Promise.all([
      projectList(),
      loadUsers(),
      get('/api/filters').then((r) => r.filters),
    ]);
  }),
);
watch(
  () => [route.query, ui.changes],
  () => {
    // bare /issues (the sidebar link): the selected project, unless All projects was picked last
    const key = props.project ? null : issuesDefaultProject(route.query, recentProjectKeys(), issuesScope());
    if (key) {
      router.replace({ query: { project: key } });
      return;
    }
    fromRoute();
    if (!props.project && !f.project) f.project = 'all';
    load();
  },
  { immediate: true, deep: true },
);

function apply(extra = {}) {
  const query = {};
  for (const k of KEYS) if (f[k] && !(props.project && k === 'project')) query[k] = f[k];
  Object.assign(query, cf.value);
  if (route.query.issue) query.issue = route.query.issue;
  router.replace({ query: { ...query, ...extra } });
}
function setSort(col) {
  if (f.sort === col) f.dir = f.dir === 'asc' ? 'desc' : 'asc';
  else {
    f.sort = col;
    f.dir = '';
  }
  apply();
}
function clearAll() {
  for (const k of KEYS) f[k] = '';
  cf.value = {};
  f.sort = 'updated';
  apply();
}
function useFilter(fl) {
  for (const k of KEYS) f[k] = fl.query[k] || '';
  cf.value = cfOf(fl.query);
  apply();
}
async function saveFilter() {
  const query = {};
  const a = apiF();
  for (const k of KEYS) if (a[k]) query[k] = a[k];
  Object.assign(query, cf.value);
  await attempt(async () => {
    await post('/api/filters', { name: saving.value.name, shared: saving.value.shared, query });
    filters.value = (await get('/api/filters')).filters;
    saving.value = null;
    toast('Filter saved');
  });
}
async function removeFilter(fl) {
  await attempt(() => del(`/api/filters/${fl.id}`), {
    then: () => {
      filters.value = filters.value.filter((x) => x.id !== fl.id);
    },
  });
}
const csvHref = computed(() => `/api/issues.csv?${qs({ ...apiF(), ...cf.value })}`);
// Google Sheets feed from the current filters
const feedOpen = ref(false);
const feedQuery = computed(() => {
  const a = apiF();
  return { ...Object.fromEntries(KEYS.filter((k) => a[k]).map((k) => [k, a[k]])), ...cf.value };
});
// one project selected: its custom fields can be filtered on
const oneProject = computed(() => (f.project && f.project !== 'all' && !f.project.includes(',') ? f.project.toUpperCase() : ''));
const projectFields = ref([]);
// field filters of another project (or of none) are dropped when the project changes
function dropOtherFieldFilters(ids) {
  const kept = Object.fromEntries(Object.entries(cf.value).filter(([k]) => ids.has(k.split('.')[1])));
  if (Object.keys(kept).length === Object.keys(cf.value).length) return;
  cf.value = kept;
  apply();
}
watch(
  oneProject,
  async (key) => {
    projectFields.value = [];
    if (!key) return dropOtherFieldFilters(new Set());
    try {
      const fields = activeFields((await fetchProject(key)).fields);
      if (oneProject.value !== key) return;
      projectFields.value = fields;
      dropOtherFieldFilters(new Set(fields.map((x) => x.id)));
    } catch {
      /* no access */
    }
  },
  { immediate: true },
);
// one project selected: filter by its components and fix versions (component=, fixVersion=: ids, names or none)
const relLists = ref({ components: [], releases: [] });
watch(
  oneProject,
  async (key) => {
    relLists.value = { components: [], releases: [] };
    if (!key) return;
    try {
      const p = props.project?.key === key ? props.project : await fetchProject(key);
      if (oneProject.value === key) relLists.value = { components: p.components || [], releases: p.releases || [] };
    } catch {
      /* no access */
    }
  },
  { immediate: true },
);
const pages = computed(() => Math.ceil(result.value.total / PAGE));

// ---- inline editing ----
const projectMap = ref({}); // project key -> project payload (statuses and workflow rules for the status select)
const canEditKey = (key) => projects.value.find((p) => p.key === key)?.canEdit;
// The project list has no statuses or workflow rules, so each project on the page is asked for once, all at
// the same time, through the project store (a project already loaded elsewhere costs no request).
async function ensureProjects() {
  const keys = [...new Set(result.value.issues.map((i) => i.projectKey))].filter((k) => !projectMap.value[k] && canEditKey(k));
  const loaded = await Promise.all(
    keys.map((k) =>
      fetchProject(k)
        .then((p) => [k, p])
        .catch(() => null),
    ),
  ); // null: no access
  if (loaded.some(Boolean)) projectMap.value = { ...projectMap.value, ...Object.fromEntries(loaded.filter(Boolean)) };
}
watch(() => [result.value, projects.value], ensureProjects);
const quickUpdate = (i, change) =>
  attempt(() => updateIssue(i.key, change), {
    then: (r) => {
      Object.assign(i, r.issue);
    },
  });

// ---- selection and bulk edit ----
const BULK_MAX = 500;
const selectedList = computed(() => Object.entries(selected.value).map(([key, projectKey]) => ({ key, projectKey })));
const nSelected = computed(() => selectedList.value.length);
const allOnPage = computed(() => result.value.issues.length > 0 && result.value.issues.every((i) => selected.value[i.key]));
const someOnPage = computed(() => result.value.issues.some((i) => selected.value[i.key]));
function clearSelection() {
  selected.value = {};
}
function toggleRow(i) {
  const next = { ...selected.value };
  if (next[i.key]) delete next[i.key];
  else if (Object.keys(next).length < BULK_MAX) next[i.key] = i.projectKey;
  else toast(`You can select up to ${BULK_MAX} issues`, 'error');
  selected.value = next;
}
function togglePage() {
  const next = { ...selected.value };
  for (const i of result.value.issues) {
    if (allOnPage.value) delete next[i.key];
    else if (Object.keys(next).length < BULK_MAX) next[i.key] = i.projectKey;
  }
  selected.value = next;
}
const selectingAll = ref(false);
async function selectAllMatching() {
  selectingAll.value = true;
  await attempt(async () => {
    const r = await get(`/api/issues?${qs({ ...apiF(), ...cf.value, limit: BULK_MAX, offset: 0 })}`);
    selected.value = Object.fromEntries(r.issues.map((i) => [i.key, i.projectKey]));
  });
  selectingAll.value = false;
}
function bulkDone({ results, deleted }) {
  if (deleted) {
    const next = { ...selected.value };
    for (const r of results) if (r.ok) delete next[r.key];
    selected.value = next;
  }
  load();
}

// ---- keyboard: j/k move, Enter or o opens, x selects, Esc clears the selection ----
function onKeys(e) {
  const tag = (e.target.tagName || '').toLowerCase();
  if (
    ['input', 'textarea', 'select'].includes(tag) ||
    e.metaKey ||
    e.ctrlKey ||
    e.altKey ||
    document.querySelector('[role=dialog]') ||
    route.query.issue
  )
    return;
  if (e.key === 'Escape' && nSelected.value) {
    clearSelection();
    return;
  }
  const n = result.value.issues.length;
  if (!n) return;
  if (e.key === 'j' || e.key === 'ArrowDown') cursor.value = Math.min(n - 1, cursor.value + 1);
  else if (e.key === 'k' || e.key === 'ArrowUp') cursor.value = Math.max(0, cursor.value - 1);
  else if ((e.key === 'Enter' || e.key === 'o') && cursor.value >= 0) return openIssue(result.value.issues[cursor.value].key);
  else if (e.key === 'x' && cursor.value >= 0) toggleRow(result.value.issues[cursor.value]);
  else return;
  e.preventDefault();
  nextTick(() => document.querySelector(`[data-row="${cursor.value}"]`)?.scrollIntoView({ block: 'nearest' }));
}
onMounted(() => window.addEventListener('keydown', onKeys));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeys));
const weekAhead = () => addDays(today(), 7);
const quick = [
  { label: 'All issues', icon: 'list', q: {} },
  { label: 'My open issues', icon: 'user', q: { assignee: 'me', category: 'todo,in_progress' } },
  { label: 'Reported by me', icon: 'chat', q: { reporter: 'me' } },
  { label: 'Watching', icon: 'bell', q: { watching: '1' } },
  { label: 'Unassigned', icon: 'help', q: { assignee: 'unassigned', category: 'todo,in_progress' } },
  { label: 'Due this week', icon: 'board', q: { category: 'todo,in_progress', dueBefore: weekAhead(), sort: 'due' } },
  { label: 'Open bugs', icon: 'shield', q: { type: 'bug', category: 'todo,in_progress' } },
  { label: 'Blocked', icon: 'block', q: { blocked: '1', category: 'todo,in_progress' } },
  { label: 'Done recently', icon: 'check', q: { category: 'done', sort: 'updated' } },
];
// A quick filter is active when the current filters are exactly its own (ignoring project on a project page).
function isActive(qf) {
  if (Object.keys(cf.value).length) return false;
  return (
    KEYS.every((k) => {
      if (k === 'sort' || k === 'dir' || k === 'project') return true; // quick filters keep the project
      const want = k === 'dueBefore' && qf.q.dueBefore ? f.dueBefore : qf.q[k] || '';
      return (f[k] || '') === want;
    }) &&
    (!qf.q.dueBefore || Boolean(f.dueBefore))
  );
}
function useQuick(qf) {
  const project = f.project;
  for (const k of KEYS) f[k] = '';
  cf.value = {};
  f.sort = 'updated';
  Object.assign(f, qf.q);
  if (!props.project) f.project = project; // the chosen project (or All projects) stays
  apply();
}
const savedOpen = ref(false);
</script>

<template>
  <div class="flex gap-4">
    <div class="min-w-0 flex-1">
      <slot name="heading" />
      <div class="-mx-1 mb-3 flex items-center gap-2 overflow-x-auto px-1 pb-1" role="toolbar" aria-label="Quick filters">
        <button
          v-for="qf in quick"
          :key="qf.label"
          class="flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors"
          :class="
            isActive(qf)
              ? 'border-accent bg-accent text-white'
              : 'border-slate-200 bg-white text-slate-700 hover:border-slate-400 hover:bg-slate-50'
          "
          :aria-pressed="isActive(qf)"
          @click="useQuick(qf)"
        >
          <Icon :name="qf.icon" :size="15" />{{ qf.label }}
        </button>
        <div class="relative shrink-0">
          <button
            class="flex items-center gap-1.5 rounded-full border border-dashed border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:border-slate-500"
            :aria-expanded="savedOpen"
            @click="savedOpen = !savedOpen"
          >
            Saved filters<span v-if="filters.length" class="rounded-full bg-slate-200 px-1.5 text-xs">{{ filters.length }}</span
            ><span aria-hidden="true">▾</span>
          </button>
        </div>
      </div>
      <div v-if="savedOpen" class="fixed inset-0 z-30" @click="savedOpen = false"></div>
      <div v-if="savedOpen" class="relative z-40 -mt-1 mb-3 rounded-[15px] border border-slate-200 bg-white p-2 shadow-lg sm:w-96">
        <p v-if="!filters.length" class="px-2 py-3 text-sm text-slate-500">
          No saved filters yet. Set up a search, then use <strong>Save filter</strong>.
        </p>
        <div v-for="fl in filters" :key="fl.id" class="group flex items-center gap-2 rounded-full px-2 hover:bg-slate-100">
          <button
            class="min-w-0 flex-1 truncate py-1.5 text-left text-sm"
            @click="
              savedOpen = false;
              useFilter(fl);
            "
          >
            {{ fl.name }}
          </button>
          <span v-if="fl.shared" class="chip shrink-0 bg-slate-100 text-slate-600" :title="`Shared by ${fl.ownerName}`">{{
            fl.mine ? 'Shared' : fl.ownerName
          }}</span>
          <button
            v-if="fl.mine"
            class="shrink-0 rounded-full px-1.5 text-slate-400 hover:text-red-700"
            :aria-label="'Delete ' + fl.name"
            @click="removeFilter(fl)"
          >
            ×
          </button>
        </div>
      </div>
      <div class="mb-3 flex flex-wrap items-end gap-2">
        <input v-model="f.q" class="input w-56" placeholder="Text or KEY-123" @keydown.enter="apply()" />
        <select
          v-if="!project"
          v-model="f.project"
          class="input w-40"
          aria-label="Project"
          @change="
            rememberIssuesScope(f.project);
            apply();
          "
        >
          <option value="all">All projects</option>
          <option v-for="p in projects" :key="p.key" :value="p.key">{{ p.name }}</option>
        </select>
        <select v-model="f.type" class="input w-32" aria-label="Type" @change="apply()">
          <option value="">All types</option>
          <option v-for="t in TYPES" :key="t.id" :value="t.id">{{ t.label }}</option>
        </select>
        <select v-model="f.category" class="input w-36" aria-label="Status" @change="apply()">
          <option value="">Any status</option>
          <option value="todo,in_progress">Open</option>
          <option v-for="c in CATEGORIES" :key="c.id" :value="c.id">{{ c.label }}</option>
        </select>
        <select v-model="f.assignee" class="input w-40" aria-label="Assignee" @change="apply()">
          <option value="">Any assignee</option>
          <option value="me">Me</option>
          <option value="unassigned">Unassigned</option>
          <option v-for="u in people" :key="u.id" :value="u.id">{{ u.name }}</option>
        </select>
        <select v-model="f.priority" class="input w-32" aria-label="Priority" @change="apply()">
          <option value="">Any priority</option>
          <option v-for="p in PRIORITIES" :key="p.id" :value="p.id">{{ p.label }}</option>
        </select>
        <input v-model="f.label" class="input w-28" placeholder="Label" @keydown.enter="apply()" />
        <select
          v-if="relLists.components.length || f.component"
          v-model="f.component"
          class="input w-40"
          aria-label="Component"
          @change="apply()"
        >
          <option value="">Any component</option>
          <option value="none">No component</option>
          <option
            v-if="f.component && f.component !== 'none' && !relLists.components.some((c) => c.id === f.component)"
            :value="f.component"
          >
            {{ f.component }}
          </option>
          <option v-for="c in relLists.components" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
        <select
          v-if="relLists.releases.length || f.fixVersion"
          v-model="f.fixVersion"
          class="input w-40"
          aria-label="Fix version"
          @change="apply()"
        >
          <option value="">Any fix version</option>
          <option value="none">No fix version</option>
          <option
            v-if="f.fixVersion && f.fixVersion !== 'none' && !relLists.releases.some((r) => r.id === f.fixVersion)"
            :value="f.fixVersion"
          >
            {{ f.fixVersion }}
          </option>
          <option v-for="r in relLists.releases" :key="r.id" :value="r.id">
            {{ r.name }}{{ r.status === 'unreleased' ? '' : ` (${r.status})` }}
          </option>
        </select>
        <FieldFilters v-model="cf" :fields="projectFields" @apply="apply()" />
        <button class="btn" @click="apply()">Search</button>
        <button class="btn btn-ghost" @click="clearAll">Clear</button>
        <div class="ml-auto flex gap-2">
          <button class="btn" @click="saving = { name: '', shared: false }">Save filter</button>
          <a class="btn" :href="csvHref">Export CSV</a>
          <button class="btn" @click="feedOpen = true">Google Sheets feed</button>
        </div>
      </div>
      <form v-if="saving" class="mb-3 flex items-center gap-2 rounded-md bg-slate-100 p-2 text-sm" @submit.prevent="saveFilter">
        <input v-model="saving.name" class="input w-64" placeholder="Filter name" required autofocus />
        <label class="flex items-center gap-1"><input v-model="saving.shared" type="checkbox" /> Share with everyone</label>
        <button class="btn btn-primary btn-sm">Save</button><button type="button" class="btn btn-sm" @click="saving = null">Cancel</button>
      </form>
      <BulkBar v-if="nSelected" :selected="selectedList" @done="bulkDone" @clear="clearSelection" />
      <div v-if="allOnPage && result.total > result.issues.length" class="mb-2 rounded-md bg-slate-100 px-3 py-1.5 text-sm">
        <template v-if="nSelected >= Math.min(result.total, BULK_MAX)"
          >All {{ nSelected }} matching issues are selected{{
            result.total > BULK_MAX ? ` (the first ${BULK_MAX} of ${result.total})` : ''
          }}.</template
        >
        <template v-else
          >{{ nSelected }} selected.
          <button class="link" :disabled="selectingAll" @click="selectAllMatching">
            {{
              result.total > BULK_MAX ? `Select the first ${BULK_MAX} of ${result.total} matching` : `Select all ${result.total} matching`
            }}
          </button></template
        >
      </div>
      <div class="card overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th class="w-8 py-2 pl-3">
                <input
                  type="checkbox"
                  :checked="allOnPage"
                  :indeterminate="someOnPage && !allOnPage"
                  :disabled="!result.issues.length"
                  aria-label="Select all issues on this page"
                  @change="togglePage"
                />
              </th>
              <th class="px-3 py-2"></th>
              <th
                v-for="c in [
                  ['key', 'Key'],
                  ['title', 'Summary'],
                  ['status', 'Status'],
                  ['priority', 'P'],
                  [null, 'Assignee'],
                  ['due', 'Due'],
                  ['updated', 'Updated'],
                ]"
                :key="c[1]"
                class="whitespace-nowrap px-3 py-2"
              >
                <button v-if="c[0]" class="uppercase hover:text-slate-800" @click="setSort(c[0])">
                  {{ c[1] }}<span v-if="f.sort === c[0]">{{ f.dir === 'asc' ? ' ▲' : f.dir === 'desc' ? ' ▼' : '' }}</span>
                </button>
                <template v-else>{{ c[1] }}</template>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(i, idx) in result.issues"
              :key="i.id"
              :data-row="idx"
              class="cursor-pointer border-t border-slate-100 hover:bg-slate-50"
              :class="[
                cursor === idx ? 'bg-blue-50 outline outline-2 -outline-offset-2 outline-accent' : '',
                selected[i.key] ? 'bg-blue-50' : '',
              ]"
              @click="
                cursor = idx;
                openIssue(i.key);
              "
            >
              <td class="py-1.5 pl-3" @click.stop>
                <input type="checkbox" :checked="!!selected[i.key]" :aria-label="`Select ${i.key}`" @change="toggleRow(i)" />
              </td>
              <td class="px-3 py-1.5"><TypeIcon :type="i.type" /></td>
              <td class="whitespace-nowrap px-3 py-1.5 font-medium text-slate-600">{{ i.key }}</td>
              <td class="px-3 py-1.5">
                {{ i.title }}<BlockedBadge :issue="i" class="ml-1" /><span
                  v-for="l in i.labels"
                  :key="l"
                  class="chip ml-1 bg-slate-100 text-slate-600"
                  >{{ l }}</span
                >
              </td>
              <td class="px-3 py-1" @click.stop>
                <StatusSelect
                  v-if="projectMap[i.projectKey]"
                  :issue="i"
                  :project="projectMap[i.projectKey]"
                  :label="`Status of ${i.key}`"
                  class="cursor-pointer rounded-full border-0 bg-transparent py-0.5 pl-0 pr-6 text-xs font-medium uppercase tracking-wide hover:bg-slate-100 focus:ring-2 focus:ring-accent/30"
                  @changed="Object.assign(i, $event.issue)"
                />
                <StatusBadge v-else :status="i.status" />
              </td>
              <td class="px-3 py-1" @click.stop>
                <select
                  v-if="canEditKey(i.projectKey)"
                  :value="i.priority"
                  class="cursor-pointer rounded-full border-0 bg-transparent py-0.5 pl-0 pr-6 text-sm hover:bg-slate-100 focus:ring-2 focus:ring-accent/30"
                  :aria-label="`Priority of ${i.key}`"
                  @change="quickUpdate(i, { priority: $event.target.value })"
                >
                  <option v-for="p in PRIORITIES" :key="p.id" :value="p.id">{{ p.arrow }} {{ p.label }}</option>
                </select>
                <PriorityIcon v-else :priority="i.priority" />
              </td>
              <td class="whitespace-nowrap px-3 py-1" @click.stop>
                <div v-if="canEditKey(i.projectKey)" class="w-44">
                  <UserSelect compact :model-value="i.assignee?.id || null" @update:model-value="quickUpdate(i, { assigneeId: $event })" />
                </div>
                <span v-else class="flex items-center gap-1.5"><Avatar :user="i.assignee" :size="20" />{{ i.assignee?.name || '' }}</span>
              </td>
              <td class="whitespace-nowrap px-3 py-1.5 text-slate-600">{{ fmtDate(i.dueDate) }}</td>
              <td class="whitespace-nowrap px-3 py-1.5 text-slate-500">{{ ago(i.updatedAt) }}</td>
            </tr>
            <tr v-if="loading || loadError">
              <td colspan="9" class="p-3"><LoadState :loading="loading" :error="loadError" :rows="6" @retry="load" /></td>
            </tr>
            <tr v-else-if="!result.issues.length">
              <td colspan="9" class="px-3 py-12 text-center text-slate-500">
                <div class="font-medium text-slate-700">No issues match these filters</div>
                <button class="link mt-1 text-sm" @click="clearAll">Clear the filters</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="mt-2 flex items-center gap-2 text-sm text-slate-600">
        {{ result.total }} issues
        <template v-if="pages > 1">
          <button class="btn btn-sm ml-auto" :disabled="page === 0" @click="apply({ page: page - 1 || undefined })">Previous</button>
          <span>Page {{ page + 1 }} of {{ pages }}</span>
          <button class="btn btn-sm" :disabled="page + 1 >= pages" @click="apply({ page: page + 1 })">Next</button>
        </template>
      </div>
    </div>
  </div>
  <SheetsFeed v-if="feedOpen" :query="feedQuery" @close="feedOpen = false" />
</template>
