<script setup>
// Project > RAID: the project's risks, assumptions, issues and decisions. Type tabs with counts, filters, sort,
// a 5x5 risk heat map (click a cell to filter), CSV export and a create/edit dialog with the entry's history.
// Guests never get here (the tab is hidden and the API answers 404).
import { ref, reactive, inject, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { get, post, patch, del, toast, session } from '../../api.js';
import { fmtDate, fmtDateTime } from '../../meta.js';
import { today as localToday } from '../../dates.js';
import {
  RAID_TYPES,
  typeOf,
  STATUS_LABELS,
  ITEM_STATUSES,
  DECISION_STATUSES,
  statusesFor,
  statusCls,
  LEVELS,
  band,
  isOverdue,
  SORTS,
  matchesFilter,
  riskHeat,
  historyText,
} from '../../raid.js';
import Modal from '../../components/Modal.vue';
import Markdown from '../../components/Markdown.vue';
import UserSelect from '../../components/UserSelect.vue';
import { attempt } from '../../composables/useAction.js';
import { useLoad } from '../../composables/useLoad.js';
import LoadState from '../../components/LoadState.vue';
import { plural } from '../../plural.js';

const project = inject('project');
const route = useRoute();
const router = useRouter();
const base = () => `/api/projects/${project.value.key}/raid`;
const f = reactive({ type: '', status: 'active', owner: '', overdue: false, q: '', sort: 'score', cell: null });

const { data, loading, error: loadError, reload: load } = useLoad(() => get(base()), null, { manual: true }); // loaded in onMounted below
onMounted(async () => {
  if (route.query.owner) f.owner = String(route.query.owner);
  if (RAID_TYPES.some((t) => t.id === route.query.type)) f.type = String(route.query.type);
  await load();
  if (route.query.entry) openEntry(String(route.query.entry));
});

const entries = computed(() => data.value?.entries || []);
const today = computed(() => data.value?.today || localToday());
const owners = computed(() => {
  const m = new Map();
  for (const e of entries.value) if (e.owner) m.set(e.owner.id, e.owner.name);
  return [...m].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
});
const statusOptions = computed(() => (f.type ? statusesFor(f.type) : [...ITEM_STATUSES, ...DECISION_STATUSES]));
watch(
  () => f.type,
  () => {
    if (f.status && f.status !== 'active' && !statusOptions.value.includes(f.status)) f.status = 'active';
  },
);

// the filters of the list; skipType: everything but the type (the type tabs count with these)
const matches = (e, skipType = false) => matchesFilter(e, f, { me: session.user?.id, today: today.value }, skipType);
const listed = computed(() => {
  const cmp = (SORTS.find((s) => s.id === f.sort) || SORTS[0]).cmp;
  return entries.value.filter((e) => matches(e)).sort((a, b) => cmp(a, b) || b.number - a.number);
});
const tabCount = (type) => entries.value.filter((e) => (!type || e.type === type) && matches(e, true)).length;

// heat map: active risks, rows probability 5 to 1, columns impact 1 to 5
const heat = computed(() => riskHeat(entries.value));
const scored = computed(() => heat.value.flat().reduce((a, b) => a + b, 0));
function pickCell(p, i) {
  if (f.cell && f.cell.p === p && f.cell.i === i) f.cell = null;
  else {
    f.cell = { p, i };
    f.type = 'risk';
    f.status = 'active';
  }
}
const cellLabel = (p, i) => {
  const n = heat.value[p - 1][i - 1];
  return `${n} open ${plural(n, 'risk')}: probability ${p} (${LEVELS[p - 1]}), impact ${i} (${LEVELS[i - 1]}), score ${p * i} ${band(p * i).label.toLowerCase()}`;
};
const filtered = computed(() => Boolean(f.type || f.status !== 'active' || f.owner || f.overdue || f.q || f.cell));
function clearFilters() {
  Object.assign(f, { type: '', status: 'active', owner: '', overdue: false, q: '', cell: null });
}

const csvHref = computed(() => {
  const q = {
    type: f.type,
    status: f.status,
    owner: f.owner,
    overdue: f.overdue ? '1' : '',
    q: f.q,
    sort: f.sort,
    probability: f.cell?.p || '',
    impact: f.cell?.i || '',
  };
  return `${base()}.csv?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== '' && v !== null && v !== undefined)).toString()}`;
});

// ---- dialog ----
const dialog = ref(null); // { mode: 'new' | 'edit', entry?, history? }
const form = reactive({});
const busy = ref(false);
const canEdit = computed(() => Boolean(data.value?.canEdit));
const editing = computed(() => canEdit.value && dialog.value);
function blank(type = 'risk') {
  return {
    type,
    title: '',
    description: '',
    ownerId: null,
    status: statusesFor(type)[0],
    reviewDate: '',
    probability: '',
    impact: '',
    mitigation: '',
    contingency: '',
    decidedBy: '',
    decidedOn: '',
    rationale: '',
    issueKeys: '',
  };
}
function newEntry() {
  Object.assign(form, blank(f.type || 'risk'));
  dialog.value = { mode: 'new' };
}
async function openEntry(id) {
  await attempt(async () => {
    const r = await get(`${base()}/${id}`);
    const e = r.entry;
    Object.assign(form, {
      type: e.type,
      title: e.title,
      description: e.description,
      ownerId: e.owner?.id || null,
      status: e.status,
      reviewDate: e.reviewDate || '',
      probability: e.probability ?? '',
      impact: e.impact ?? '',
      mitigation: e.mitigation,
      contingency: e.contingency,
      decidedBy: e.decidedBy,
      decidedOn: e.decidedOn || '',
      rationale: e.rationale,
      issueKeys: e.links.map((l) => l.key).join(', '),
    });
    dialog.value = { mode: 'edit', entry: e, history: r.history };
  });
}
function close() {
  dialog.value = null;
  if (route.query.entry) router.replace({ query: { ...route.query, entry: undefined } });
}
watch(
  () => form.type,
  (t) => {
    if (dialog.value && !statusesFor(t).includes(form.status)) form.status = statusesFor(t)[0];
  },
);
const formScore = computed(() => (form.probability && form.impact ? Number(form.probability) * Number(form.impact) : null));
function payload() {
  const b = {
    ...form,
    reviewDate: form.reviewDate || null,
    decidedOn: form.decidedOn || null,
    issueKeys: form.issueKeys.split(/[\s,]+/).filter(Boolean),
  };
  b.probability = form.probability === '' ? null : Number(form.probability);
  b.impact = form.impact === '' ? null : Number(form.impact);
  return b;
}
async function save() {
  busy.value = true;
  await attempt(async () => {
    if (dialog.value.mode === 'new') {
      const r = await post(base(), payload());
      toast(`Created ${r.entry.ref}`);
    } else {
      const r = await patch(`${base()}/${dialog.value.entry.id}`, payload());
      toast(r.changed.length ? `Saved ${r.entry.ref}` : 'No changes');
    }
    close();
    await load();
  });
  busy.value = false;
}
async function remove() {
  const e = dialog.value.entry;
  if (!confirm(`Delete ${e.ref} "${e.title}"? Its history goes too. This cannot be undone.`)) return;
  await attempt(async () => {
    await del(`${base()}/${e.id}`);
    toast(`Deleted ${e.ref}`);
    close();
    await load();
  });
}
</script>

<template>
  <div class="max-w-6xl space-y-3">
    <div class="flex flex-wrap items-center gap-2">
      <div class="flex max-w-full flex-wrap gap-1" role="group" aria-label="Entry type">
        <button
          class="rounded-full border px-3 py-1 text-sm"
          :class="!f.type ? 'border-accent bg-accent text-white' : 'border-slate-200 bg-white text-slate-700 hover:border-slate-400'"
          :aria-pressed="!f.type"
          @click="f.type = ''"
        >
          All<span v-if="data" class="ml-1 text-xs">{{ tabCount('') }}</span>
        </button>
        <button
          v-for="t in RAID_TYPES"
          :key="t.id"
          class="rounded-full border px-3 py-1 text-sm"
          :class="
            f.type === t.id ? 'border-accent bg-accent text-white' : 'border-slate-200 bg-white text-slate-700 hover:border-slate-400'
          "
          :aria-pressed="f.type === t.id"
          @click="
            f.type = t.id;
            if (t.id !== 'risk') f.cell = null;
          "
        >
          {{ t.plural }}<span v-if="data" class="ml-1 text-xs">{{ tabCount(t.id) }}</span>
        </button>
      </div>
      <div class="ml-auto flex gap-2">
        <a class="btn btn-sm" :href="csvHref" download>Export CSV</a>
        <button v-if="canEdit" class="btn btn-sm btn-primary" @click="newEntry">New entry</button>
      </div>
    </div>

    <LoadState v-if="!data" :loading="loading" :error="loadError" :rows="5" @retry="load" />
    <div v-else class="grid gap-3 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <div class="min-w-0 space-y-3">
        <div class="card grid grid-cols-2 gap-2 p-3 sm:grid-cols-4" role="search" aria-label="Filter RAID entries">
          <div class="col-span-2 sm:col-span-4">
            <label class="label" for="raid-q">Search</label
            ><input id="raid-q" v-model="f.q" class="input" placeholder="Title, description or RAID-12" />
          </div>
          <div>
            <label class="label" for="raid-status">Status</label>
            <select id="raid-status" v-model="f.status" class="input">
              <option value="active">Not closed</option>
              <option value="">Any status</option>
              <option v-for="s in statusOptions" :key="s" :value="s">{{ STATUS_LABELS[s] }}</option>
            </select>
          </div>
          <div>
            <label class="label" for="raid-owner">Owner</label>
            <select id="raid-owner" v-model="f.owner" class="input">
              <option value="">Anyone</option>
              <option value="me">Me</option>
              <option value="none">No owner</option>
              <option v-for="o in owners" :key="o.id" :value="o.id">{{ o.name }}</option>
            </select>
          </div>
          <div>
            <label class="label" for="raid-sort">Sort by</label>
            <select id="raid-sort" v-model="f.sort" class="input">
              <option v-for="s in SORTS" :key="s.id" :value="s.id">{{ s.label }}</option>
            </select>
          </div>
          <div class="flex items-end pb-1.5">
            <label class="flex items-center gap-1.5 text-sm"><input v-model="f.overdue" type="checkbox" /> Overdue only</label>
          </div>
          <div v-if="filtered" class="col-span-2 flex flex-wrap items-center gap-2 text-sm sm:col-span-4">
            <span v-if="f.cell" class="chip border border-slate-300 bg-white text-slate-800"
              >Probability {{ f.cell.p }}, impact {{ f.cell.i }}</span
            >
            <button class="link text-sm" @click="clearFilters">Clear filters</button>
          </div>
        </div>

        <p class="sr-only" aria-live="polite">{{ listed.length }} entries shown</p>
        <div v-if="!listed.length" class="card p-6 text-center text-sm text-slate-600">
          <template v-if="!entries.length"
            >No RAID entries yet.<template v-if="canEdit"> Add risks, assumptions, issues and decisions with New entry.</template></template
          >
          <template v-else>No entries match these filters.</template>
        </div>
        <ul v-else class="card divide-y divide-slate-100">
          <li v-for="e in listed" :key="e.id">
            <button
              class="grid w-full gap-1 px-3 py-2.5 text-left hover:bg-slate-50 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-3"
              @click="openEntry(e.id)"
            >
              <span class="min-w-0">
                <span class="flex flex-wrap items-center gap-1.5">
                  <span class="text-xs font-semibold text-slate-600">{{ e.ref }}</span>
                  <span class="chip" :class="typeOf(e.type).cls">{{ typeOf(e.type).label }}</span>
                  <span class="min-w-0 break-words font-medium">{{ e.title }}</span>
                </span>
                <span class="mt-0.5 flex flex-wrap gap-x-3 text-xs text-slate-600">
                  <span>{{ e.owner ? e.owner.name : 'No owner' }}</span>
                  <span v-if="e.reviewDate" :class="isOverdue(e, today) ? 'font-semibold text-red-800' : ''"
                    >{{ isOverdue(e, today) ? 'Overdue: review' : 'Review' }} {{ fmtDate(e.reviewDate) }}</span
                  >
                  <span v-if="e.links.length">{{ e.links.length }} linked {{ plural(e.links.length, 'issue') }}</span>
                </span>
              </span>
              <span class="flex flex-wrap items-center gap-1.5">
                <span
                  v-if="e.score"
                  class="chip border"
                  :class="band(e.score).cls"
                  :title="`Probability ${e.probability} x impact ${e.impact}`"
                  >Score {{ e.score }} {{ band(e.score).label }}</span
                >
                <span class="chip" :class="statusCls(e.status)">{{ STATUS_LABELS[e.status] }}</span>
              </span>
            </button>
          </li>
        </ul>
      </div>

      <section class="card h-fit p-3" aria-labelledby="raid-heat-h">
        <h2 id="raid-heat-h" class="text-sm font-semibold">Risk heat map</h2>
        <p class="mb-2 text-xs text-slate-600">
          Open risks by probability and impact ({{ scored }} rated). Select a cell to list those risks.
        </p>
        <div
          class="grid grid-cols-[1.25rem_repeat(5,minmax(0,1fr))] gap-1"
          role="group"
          aria-label="Open risks: probability (rows, 5 at the top) by impact (columns)"
        >
          <template v-for="p in [5, 4, 3, 2, 1]" :key="p">
            <div class="flex items-center justify-center text-xs font-semibold text-slate-600" aria-hidden="true">{{ p }}</div>
            <button
              v-for="i in [1, 2, 3, 4, 5]"
              :key="i"
              type="button"
              class="relative flex aspect-square min-h-11 flex-col items-center justify-center rounded border text-sm"
              :class="[
                band(p * i).cls,
                f.cell && f.cell.p === p && f.cell.i === i ? 'ring-2 ring-black ring-offset-1' : '',
                heat[p - 1][i - 1] ? 'font-bold' : 'opacity-80',
              ]"
              :aria-pressed="Boolean(f.cell && f.cell.p === p && f.cell.i === i)"
              @click="pickCell(p, i)"
            >
              <span>{{ heat[p - 1][i - 1] }}</span><span class="sr-only">{{ cellLabel(p, i).replace(/^\d+/, '') }}</span
              ><span class="text-[10px] font-normal" aria-hidden="true">{{ p * i }}</span>
            </button>
          </template>
          <div></div>
          <div v-for="i in [1, 2, 3, 4, 5]" :key="'i' + i" class="text-center text-xs font-semibold text-slate-600" aria-hidden="true">
            {{ i }}
          </div>
        </div>
        <p class="mt-1 text-center text-xs text-slate-600" aria-hidden="true">Impact &rarr; (rows: probability)</p>
        <p class="mt-2 text-xs text-slate-600">
          Large number: open risks in the cell. Small number: the score. Score 12 to 25 is High, 5 to 11 Medium, 1 to 4 Low.
        </p>
      </section>
    </div>

    <Modal
      v-if="dialog"
      wide
      :title="dialog.mode === 'new' ? 'New RAID entry' : `${dialog.entry.ref} ${typeOf(dialog.entry.type).label}`"
      @close="close"
    >
      <form id="raid-form" class="space-y-3" @submit.prevent="save">
        <fieldset :disabled="!editing" class="grid gap-3 sm:grid-cols-2">
          <legend class="sr-only">Entry</legend>
          <div>
            <label class="label" for="rf-type">Type</label>
            <select id="rf-type" v-model="form.type" class="input">
              <option v-for="t in RAID_TYPES" :key="t.id" :value="t.id">{{ t.label }}</option>
            </select>
          </div>
          <div>
            <label class="label" for="rf-status">Status</label>
            <select id="rf-status" v-model="form.status" class="input">
              <option v-for="s in statusesFor(form.type)" :key="s" :value="s">{{ STATUS_LABELS[s] }}</option>
            </select>
          </div>
          <div class="sm:col-span-2">
            <label class="label" for="rf-title">Title</label
            ><input id="rf-title" v-model="form.title" class="input" maxlength="300" required />
          </div>
          <div class="sm:col-span-2">
            <label class="label" for="rf-desc">Description (Markdown)</label>
            <textarea v-if="editing" id="rf-desc" v-model="form.description" class="input" rows="4" maxlength="20000"></textarea>
            <div v-else id="rf-desc" class="rounded-md border border-slate-200 p-2 text-sm">
              <Markdown v-if="form.description" :text="form.description" /><span v-else class="text-slate-500">No description</span>
            </div>
          </div>
          <div>
            <span id="rf-owner-l" class="label">Owner</span>
            <UserSelect v-if="editing" v-model="form.ownerId" placeholder="No owner" aria-labelledby="rf-owner-l" />
            <p v-else class="text-sm">{{ dialog.entry?.owner?.name || 'No owner' }}</p>
          </div>
          <div>
            <label class="label" for="rf-review">{{ form.type === 'decision' ? 'Decision due' : 'Review date' }}</label><input
              id="rf-review"
              v-model="form.reviewDate"
              type="date"
              class="input"
            />
          </div>

          <template v-if="form.type === 'risk'">
            <div>
              <label class="label" for="rf-prob">Probability</label>
              <select id="rf-prob" v-model="form.probability" class="input">
                <option value="">Not rated</option>
                <option v-for="n in 5" :key="n" :value="n">{{ n }} {{ LEVELS[n - 1] }}</option>
              </select>
            </div>
            <div>
              <label class="label" for="rf-impact">Impact</label>
              <select id="rf-impact" v-model="form.impact" class="input">
                <option value="">Not rated</option>
                <option v-for="n in 5" :key="n" :value="n">{{ n }} {{ LEVELS[n - 1] }}</option>
              </select>
            </div>
            <p class="text-sm sm:col-span-2" aria-live="polite">
              Score:
              <span v-if="formScore" class="chip border" :class="band(formScore).cls">{{ formScore }} {{ band(formScore).label }}</span
              ><span v-else class="text-slate-600">rate probability and impact</span>
            </p>
            <div>
              <label class="label" for="rf-mit">Mitigation</label
              ><textarea
                id="rf-mit"
                v-model="form.mitigation"
                class="input"
                rows="3"
                maxlength="20000"
                placeholder="What we do now to make it less likely or smaller"
              ></textarea>
            </div>
            <div>
              <label class="label" for="rf-cont">Contingency</label
              ><textarea
                id="rf-cont"
                v-model="form.contingency"
                class="input"
                rows="3"
                maxlength="20000"
                placeholder="What we do if it happens"
              ></textarea>
            </div>
          </template>

          <template v-if="form.type === 'decision'">
            <div>
              <label class="label" for="rf-by">Decided by</label
              ><input id="rf-by" v-model="form.decidedBy" class="input" maxlength="200" placeholder="A name, e.g. the client sponsor" />
            </div>
            <div>
              <label class="label" for="rf-on">Decided on</label><input id="rf-on" v-model="form.decidedOn" type="date" class="input" />
            </div>
            <div class="sm:col-span-2">
              <label class="label" for="rf-why">Rationale</label
              ><textarea id="rf-why" v-model="form.rationale" class="input" rows="3" maxlength="20000"></textarea>
            </div>
          </template>

          <div class="sm:col-span-2">
            <label class="label" for="rf-links">Linked issues</label>
            <input
              v-if="editing"
              id="rf-links"
              v-model="form.issueKeys"
              class="input"
              :placeholder="`Issue keys of this project, e.g. ${project.key}-12, ${project.key}-15`"
              aria-describedby="rf-links-help"
            />
            <p v-if="editing" id="rf-links-help" class="mt-1 text-xs text-slate-600">Up to 40, separated by commas or spaces.</p>
            <p v-if="dialog.entry?.links.length" class="mt-1 flex flex-wrap gap-2 text-sm">
              <RouterLink
                v-for="l in dialog.entry.links"
                :key="l.key"
                :to="`/browse/${l.key}`"
                class="link"
                :class="l.done ? 'line-through' : ''"
                >{{ l.key }} {{ l.title }}</RouterLink
              >
            </p>
            <p v-else-if="!editing" class="text-sm text-slate-600">None</p>
          </div>
        </fieldset>
      </form>
      <details v-if="dialog.history?.length" class="mt-4 text-sm">
        <summary class="cursor-pointer font-semibold">History ({{ dialog.history.length }})</summary>
        <ol class="mt-2 space-y-1">
          <li v-for="h in [...dialog.history].reverse()" :key="h.id" class="text-slate-700">
            <span class="font-medium">{{ h.actor?.name || 'Someone' }}</span> {{ historyText(h) }}
            <span class="text-xs text-slate-600">{{ fmtDateTime(h.createdAt) }}</span>
          </li>
        </ol>
      </details>
      <template #footer>
        <button v-if="dialog.mode === 'edit' && data.canAdmin" type="button" class="btn btn-danger mr-auto" @click="remove">Delete</button>
        <button type="button" class="btn" @click="close">{{ editing ? 'Cancel' : 'Close' }}</button>
        <button v-if="editing" type="submit" form="raid-form" class="btn btn-primary" :disabled="busy">
          {{ dialog.mode === 'new' ? 'Create' : 'Save' }}
        </button>
      </template>
    </Modal>
  </div>
</template>
