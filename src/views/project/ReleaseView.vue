<script setup>
// A release page: progress, its issues by status category, the Release action and release notes.
import { ref, reactive, inject, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { get, post, patch, del, toast } from '../../api.js';
import { copyText } from '../../browser.js';
import { ui, openIssue } from '../../ui.js';
import { fmtDate, fmtDateTime } from '../../meta.js';
import { today } from '../../dates.js';
import { RELEASE_STATUS } from '../../releases.js';
import { attempt, useAction } from '../../composables/useAction.js';
import ReleaseProgress from '../../components/ReleaseProgress.vue';
import IssueRow from '../../components/IssueRow.vue';
import Markdown from '../../components/Markdown.vue';
import Skeleton from '../../components/Skeleton.vue';
import { plural } from '../../plural.js';

const project = inject('project');
const reloadProject = inject('reloadProject');
const route = useRoute();
const router = useRouter();
const data = ref(null);
const error = ref('');
const panel = ref(null); // 'release' | 'edit' | 'delete' | 'notes'
const { busy, run: act } = useAction();
const base = () => `/api/projects/${project.value.key}/releases/${route.params.id}`;

async function load() {
  if (!route.params.id) return; // leaving the page
  try {
    data.value = await get(base());
    error.value = '';
  } catch (e) {
    error.value = e.message;
  }
}
watch(() => [route.params.id, ui.changes], load, { immediate: true });
const rel = computed(() => data.value?.release);
const GROUPS = [
  { id: 'todo', label: 'To do' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'done', label: 'Done' },
];
const grouped = computed(() => GROUPS.map((g) => ({ ...g, issues: (data.value?.issues || []).filter((i) => i.status.category === g.id) })));
const openCount = computed(() => (data.value?.issues || []).filter((i) => i.status.category !== 'done').length);

// a change to the release: close the panel, reload the release and the project's release list
const run = (fn, ok) =>
  act(fn, {
    ok,
    then: async () => {
      panel.value = null;
      await load();
      reloadProject();
    },
  });

// ---- Release ----
const releaseForm = reactive({ date: '', move: 'none' }); // move: 'none' or a release id
function startRelease() {
  releaseForm.date = rel.value.releaseDate || today();
  releaseForm.move = data.value.moveTargets[0]?.id || 'none';
  panel.value = 'release';
}
const doRelease = () =>
  run(async () => {
    const b = { releaseDate: releaseForm.date || null };
    if (openCount.value) b.moveOpenTo = releaseForm.move === 'none' ? null : releaseForm.move;
    const r = await post(`${base()}/release`, b);
    toast(
      r.moved
        ? `Released ${r.release.name}. ${r.moved} open ${plural(r.moved, 'issue')} ${r.movedTo ? `moved to ${r.movedTo.name}` : 'taken off this version'}.`
        : `Released ${r.release.name}`,
    );
  });

// ---- edit, archive, unrelease, delete ----
const editForm = reactive({});
function startEdit() {
  Object.assign(editForm, {
    name: rel.value.name,
    description: rel.value.description,
    startDate: rel.value.startDate || '',
    releaseDate: rel.value.releaseDate || '',
  });
  panel.value = 'edit';
}
const saveEdit = () =>
  run(
    () => patch(base(), { ...editForm, startDate: editForm.startDate || null, releaseDate: editForm.releaseDate || null }),
    'Release saved',
  );
const setStatus = (status) => run(() => patch(base(), { status }), status === 'archived' ? 'Archived' : 'Moved back to unreleased');
const deleteForm = reactive({ moveTo: '' });
async function doDelete() {
  await act(() => del(`${base()}${deleteForm.moveTo ? `?moveTo=${encodeURIComponent(deleteForm.moveTo)}` : ''}`), {
    ok: `Deleted ${rel.value.name}`,
    then: () => {
      reloadProject();
      router.push(`/projects/${project.value.key}/releases`);
    },
  });
}

// ---- release notes ----
const notes = ref(null); // { markdown, filename }
const showSource = ref(false);
async function openNotes() {
  panel.value = panel.value === 'notes' ? null : 'notes';
  if (panel.value !== 'notes') return;
  await attempt(async () => {
    notes.value = await get(`${base()}/notes`);
  });
}
const copyNotes = () =>
  copyText(notes.value.markdown, { ok: 'Release notes copied', fail: 'Copying is blocked here. Use Download instead.' });
</script>

<template>
  <div v-if="error" class="py-12 text-center text-slate-600">
    {{ error }} <RouterLink :to="`/projects/${project.key}/releases`" class="link">Back to releases</RouterLink>
  </div>
  <Skeleton v-else-if="!data" :rows="6" />
  <div v-else class="max-w-5xl space-y-4">
    <div>
      <RouterLink :to="`/projects/${project.key}/releases`" class="text-xs text-slate-500 hover:underline">Releases</RouterLink>
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="text-lg font-semibold">{{ rel.name }}</h2>
        <span class="chip" :class="RELEASE_STATUS[rel.status].cls">{{ RELEASE_STATUS[rel.status].label }}</span>
        <span v-if="rel.overdue" class="chip bg-red-100 text-red-800">Overdue</span>
      </div>
      <p class="text-sm text-slate-600">
        <template v-if="rel.startDate">Start {{ fmtDate(rel.startDate) }}. </template>
        <template v-if="rel.status === 'released'"
          >Released {{ fmtDate(rel.releaseDate)
          }}<span v-if="rel.releasedAt" class="text-xs text-slate-500"> (marked {{ fmtDateTime(rel.releasedAt) }})</span>.</template
        >
        <template v-else-if="rel.releaseDate">Release date {{ fmtDate(rel.releaseDate) }}.</template>
        <template v-else>No release date.</template>
      </p>
      <p v-if="rel.description" class="mt-1 whitespace-pre-wrap text-sm">{{ rel.description }}</p>
    </div>

    <div class="card grid gap-4 p-3 sm:grid-cols-2">
      <div><span class="label">Issues</span><ReleaseProgress :progress="rel.progress" /></div>
      <div><span class="label">Story points</span><ReleaseProgress :progress="rel.progress" by="points" /></div>
    </div>

    <div class="flex flex-wrap gap-2">
      <template v-if="data.canAdmin">
        <button v-if="rel.status === 'unreleased'" class="btn btn-sm btn-primary" :disabled="busy" @click="startRelease">Release</button>
        <button v-if="rel.status === 'released'" class="btn btn-sm" :disabled="busy" @click="setStatus('unreleased')">Unrelease</button>
        <button class="btn btn-sm" :disabled="busy" @click="startEdit">Edit</button>
        <button v-if="rel.status !== 'archived'" class="btn btn-sm" :disabled="busy" @click="setStatus('archived')">Archive</button>
        <button v-else class="btn btn-sm" :disabled="busy" @click="setStatus('unreleased')">Restore</button>
      </template>
      <button class="btn btn-sm" :aria-expanded="panel === 'notes'" @click="openNotes">Release notes</button>
      <RouterLink :to="`/projects/${project.key}/issues?fixVersion=${rel.id}`" class="btn btn-sm btn-ghost">Open in Issues</RouterLink>
      <button
        v-if="data.canAdmin"
        class="btn btn-sm btn-danger sm:ml-auto"
        :disabled="busy"
        @click="
          panel = 'delete';
          deleteForm.moveTo = '';
        "
      >
        Delete
      </button>
    </div>

    <form v-if="panel === 'release'" class="card space-y-3 p-3 text-sm" @submit.prevent="doRelease">
      <h3 class="font-semibold">Release {{ rel.name }}</h3>
      <div>
        <label class="label" for="rv-date">Release date</label
        ><input id="rv-date" v-model="releaseForm.date" type="date" class="input w-auto" />
      </div>
      <p v-if="!openCount">All {{ data.total }} issues are done.</p>
      <div v-else class="space-y-2 rounded-md bg-amber-50 p-2">
        <p>{{ openCount }} {{ plural(openCount, 'issue is', 'issues are') }} not done. Release anyway and:</p>
        <label class="block"
          ><span class="label">Open issues</span>
          <select v-model="releaseForm.move" class="input">
            <option v-for="t in data.moveTargets" :key="t.id" :value="t.id">Move to {{ t.name }}</option>
            <option value="none">Take them off this version (no fix version)</option>
          </select></label
        >
      </div>
      <div class="flex gap-2">
        <button class="btn btn-primary" :disabled="busy">{{ openCount ? 'Release anyway' : 'Release' }}</button><button
          type="button"
          class="btn"
          @click="panel = null"
        >
          Cancel
        </button>
      </div>
    </form>

    <form v-if="panel === 'edit'" class="card grid gap-3 p-3 sm:grid-cols-2" @submit.prevent="saveEdit">
      <div>
        <label class="label" for="re-name">Name</label><input id="re-name" v-model="editForm.name" class="input" maxlength="80" required />
      </div>
      <div>
        <label class="label" for="re-start">Start date</label><input id="re-start" v-model="editForm.startDate" type="date" class="input" />
      </div>
      <div>
        <label class="label" for="re-date">Release date</label
        ><input id="re-date" v-model="editForm.releaseDate" type="date" class="input" :min="editForm.startDate || undefined" />
      </div>
      <div class="sm:col-span-2">
        <label class="label" for="re-desc">Description</label
        ><textarea id="re-desc" v-model="editForm.description" class="input" rows="3" maxlength="5000"></textarea>
      </div>
      <div class="flex gap-2 sm:col-span-2">
        <button class="btn btn-primary" :disabled="busy">Save</button
        ><button type="button" class="btn" @click="panel = null">Cancel</button>
      </div>
    </form>

    <form v-if="panel === 'delete'" class="card space-y-2 bg-red-50 p-3 text-sm" @submit.prevent="doDelete">
      <p>
        Delete <strong>{{ rel.name }}</strong>? It is taken off {{ rel.progress.total }} {{ plural(rel.progress.total, 'issue') }}. The
        issues stay.
      </p>
      <label v-if="rel.progress.total && data.moveTargets.length" class="block"
        ><span class="label">Give its issues this fix version instead</span>
        <select v-model="deleteForm.moveTo" class="input">
          <option value="">None</option>
          <option v-for="t in data.moveTargets" :key="t.id" :value="t.id">{{ t.name }}</option>
        </select></label
      >
      <div class="flex gap-2">
        <button class="btn btn-sm btn-danger" :disabled="busy">Delete release</button
        ><button type="button" class="btn btn-sm" @click="panel = null">Cancel</button>
      </div>
    </form>

    <section v-if="panel === 'notes'" class="card p-3" aria-labelledby="rn-title">
      <div class="mb-2 flex flex-wrap items-center gap-2">
        <h3 id="rn-title" class="font-semibold">Release notes</h3>
        <div class="ml-auto flex flex-wrap gap-2">
          <button class="btn btn-sm btn-ghost" :disabled="!notes" @click="showSource = !showSource">
            {{ showSource ? 'Preview' : 'Markdown' }}
          </button>
          <button class="btn btn-sm" :disabled="!notes" @click="copyNotes">Copy</button>
          <a class="btn btn-sm" :href="`${base()}/notes?download=1`" :download="notes?.filename">Download .md</a>
        </div>
      </div>
      <p class="mb-2 text-xs text-slate-500">
        Done issues grouped by type: stories and epics under Features, tasks under Improvements, bugs under Bug fixes. Sub-tasks are left
        out.
      </p>
      <Skeleton v-if="!notes" :rows="3" />
      <pre v-else-if="showSource" class="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-slate-50 p-2 text-xs">{{
        notes.markdown
      }}</pre>
      <Markdown v-else :text="notes.markdown" class="max-h-96 overflow-auto" />
    </section>

    <section v-for="g in grouped" :key="g.id" :aria-labelledby="'rg-' + g.id">
      <h3 :id="'rg-' + g.id" class="mb-1 text-sm font-semibold">
        {{ g.label }} <span class="font-normal text-slate-500">{{ g.issues.length }}</span>
      </h3>
      <div v-if="g.issues.length" class="card divide-y divide-slate-100 overflow-x-auto">
        <IssueRow v-for="i in g.issues" :key="i.key" :issue="i" @open="openIssue($event.key)" />
      </div>
      <p v-else class="text-sm text-slate-400">None</p>
    </section>
    <p v-if="data.total > data.issues.length" class="text-xs text-slate-500">
      Showing {{ data.issues.length }} of {{ data.total }} issues.
      <RouterLink :to="`/projects/${project.key}/issues?fixVersion=${rel.id}`" class="link">See all in Issues</RouterLink>
    </p>
  </div>
</template>
