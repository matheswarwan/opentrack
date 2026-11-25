<script setup>
// Project > Status, one report: read it, or (project admins, while it is a draft) edit, preview and publish it.
// Copy as text gives Markdown; Download opens the print page (browser Print > Save as PDF).
import { ref, reactive, inject, computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import { get, post, patch, del, toast } from '../../api.js';
import { copyText } from '../../browser.js';
import { RAG, RAG_AREAS, SECTIONS, periodText, ragLabel, reportMarkdown, itemText, groups } from '../../statusReport.js';
import Markdown from '../Markdown.vue';
import Skeleton from '../Skeleton.vue';
import { attempt } from '../../composables/useAction.js';
import { plural } from '../../plural.js';

const props = defineProps({
  id: { type: String, required: true }, // the report
  aiAvailable: Boolean,
  loadList: { type: Function, required: true }, // the list changed (published, unpublished, deleted)
});
const canAdmin = defineModel('canAdmin', { type: Boolean }); // the report's answer updates the page's
const project = inject('project');
const router = useRouter();
const report = ref(null);
const edit = reactive({ summary: '', rag: {}, sections: {}, sharedWithGuests: false });
const dirty = ref(false);
const busy = ref(false);
const mode = ref('edit'); // edit | preview
const newDecision = ref('');
const base = () => `/api/projects/${project.value.key}/status-reports`;
const editable = computed(() => canAdmin.value && report.value?.status === 'draft');

function take(r) {
  report.value = r;
  Object.assign(edit, {
    summary: r.summary,
    rag: JSON.parse(JSON.stringify(r.rag)),
    sections: JSON.parse(JSON.stringify(r.sections)),
    sharedWithGuests: r.sharedWithGuests,
  });
  dirty.value = false;
}
async function loadReport() {
  report.value = null;
  try {
    const r = await get(`${base()}/${props.id}`);
    canAdmin.value = r.canAdmin;
    take(r.report);
    mode.value = editable.value ? 'edit' : 'preview';
  } catch (e) {
    toast(e.message, 'error');
    router.replace(`/projects/${project.value.key}/status`);
  }
}
watch(() => props.id, loadReport, { immediate: true });
watch(
  edit,
  () => {
    if (report.value) dirty.value = true;
  },
  { deep: true, flush: 'sync' },
);

async function save(quiet = false) {
  busy.value = true;
  try {
    const rag = Object.fromEntries(Object.entries(edit.rag).map(([k, v]) => [k, { value: v.value, reason: v.reason || '' }]));
    const r = await patch(`${base()}/${report.value.id}`, {
      summary: edit.summary,
      rag,
      sections: edit.sections,
      sharedWithGuests: edit.sharedWithGuests,
    });
    take(r.report);
    if (!quiet) toast('Saved');
    return true;
  } catch (e) {
    toast(e.message, 'error');
    return false;
  } finally {
    busy.value = false;
  }
}
async function publish() {
  if (dirty.value && !(await save(true))) return;
  if (
    !confirm(
      edit.sharedWithGuests
        ? 'Publish this report? Project members and the project guests (the client) will be notified.'
        : 'Publish this report? Project members will be notified. Guests will not see it.',
    )
  )
    return;
  busy.value = true;
  await attempt(async () => {
    const r = await post(`${base()}/${report.value.id}/publish`);
    take(r.report);
    mode.value = 'preview';
    toast(`Published. ${r.notified} ${plural(r.notified, 'person', 'people')} notified.`);
    props.loadList();
  });
  busy.value = false;
}
async function unpublish() {
  if (!confirm('Unpublish this report? It becomes a draft again and people can no longer read it as published.')) return;
  busy.value = true;
  await attempt(async () => {
    take((await post(`${base()}/${report.value.id}/unpublish`)).report);
    mode.value = 'edit';
    props.loadList();
  });
  busy.value = false;
}
async function remove() {
  if (!confirm('Delete this draft?')) return;
  await attempt(async () => {
    await del(`${base()}/${report.value.id}`);
    toast('Draft deleted');
    await props.loadList();
    router.push(`/projects/${project.value.key}/status`);
  });
}
async function aiDraft() {
  busy.value = true;
  try {
    if (dirty.value && !(await save(true))) return;
    const r = await post(`${base()}/${report.value.id}/ai-summary`);
    edit.summary = r.summary;
    toast('Summary drafted. Check it, then Save.');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    busy.value = false;
  }
}

const view = computed(() => (report.value ? { ...report.value, summary: edit.summary, rag: edit.rag, sections: edit.sections } : null));
const bodyMd = computed(() => (view.value ? reportMarkdown(view.value, project.value, { head: false }) : ''));
const copyReport = () => copyText(reportMarkdown(view.value, project.value), { ok: 'Copied as Markdown', fail: 'Could not copy' });
const printUrl = computed(() => (report.value ? `/projects/${project.value.key}/status/${report.value.id}/print` : ''));

function move(sec, i, d) {
  const list = edit.sections[sec].items;
  const j = i + d;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
}
const removeItem = (sec, i) => edit.sections[sec].items.splice(i, 1);
function addDecision() {
  const t = newDecision.value.trim();
  if (!t) return;
  edit.sections.decisions.items.push({ text: t });
  newDecision.value = '';
}
const areas = computed(() => RAG_AREAS.filter((a) => edit.rag[a.id]));
const sections = computed(() => SECTIONS.filter((s) => edit.sections[s.id]));
const overridden = (a) => edit.rag[a].value !== edit.rag[a].suggested;
</script>

<template>
  <Skeleton v-if="!report" :rows="6" />
  <template v-else>
    <div class="flex flex-wrap items-center gap-2">
      <RouterLink :to="`/projects/${project.key}/status`" class="link text-sm">All reports</RouterLink>
      <h2 class="text-base font-semibold">{{ periodText(report) }}</h2>
      <span class="chip bg-slate-100 text-slate-700">{{ report.status === 'draft' ? 'Draft' : 'Published' }}</span>
      <span v-if="dirty && editable" class="text-xs text-slate-500">Unsaved changes</span>
      <div class="ml-auto flex flex-wrap gap-2">
        <div v-if="editable" class="flex gap-1" role="group" aria-label="View">
          <button class="btn btn-sm" :class="mode === 'edit' ? 'btn-dark' : ''" :aria-pressed="mode === 'edit'" @click="mode = 'edit'">
            Edit
          </button>
          <button
            class="btn btn-sm"
            :class="mode === 'preview' ? 'btn-dark' : ''"
            :aria-pressed="mode === 'preview'"
            @click="mode = 'preview'"
          >
            Preview
          </button>
        </div>
        <button class="btn btn-sm" @click="copyReport">Copy as text</button>
        <a class="btn btn-sm" :href="printUrl" target="_blank" rel="noopener">Download</a>
        <template v-if="editable">
          <button class="btn btn-sm" :disabled="busy || !dirty" @click="save()">Save</button>
          <button class="btn btn-sm btn-primary" :disabled="busy" @click="publish">Publish</button>
          <button class="btn btn-sm btn-danger" :disabled="busy" @click="remove">Delete</button>
        </template>
        <button v-else-if="canAdmin" class="btn btn-sm" :disabled="busy" @click="unpublish">Unpublish</button>
      </div>
    </div>
    <p class="text-xs text-slate-500">
      <template v-if="report.author">By {{ report.author.name }}. </template>
      <template v-if="report.publishedAt">Published {{ new Date(report.publishedAt).toLocaleString() }}. </template>
      <template v-if="report.status === 'published' && canAdmin">Published reports are read only. Unpublish to change it.</template>
    </p>

    <!-- RAG -->
    <section class="card p-3" aria-labelledby="sr-rag">
      <h3 id="sr-rag" class="mb-2 text-sm font-semibold">RAG status</h3>
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div
          v-for="a in areas"
          :key="a.id"
          class="space-y-1 rounded-lg border border-slate-200 p-2"
          :class="a.id === 'overall' ? 'sm:col-span-2 lg:col-span-3' : ''"
        >
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-sm font-semibold">{{ a.label }}</span>
            <span class="chip border" :class="RAG[edit.rag[a.id].value]?.cls">{{ ragLabel(edit.rag[a.id].value) }}</span>
            <span v-if="overridden(a.id)" class="text-xs text-slate-500">Suggested: {{ ragLabel(edit.rag[a.id].suggested) }}</span>
          </div>
          <ul class="list-disc pl-5 text-xs text-slate-600">
            <li v-for="w in edit.rag[a.id].why" :key="w">{{ w }}</li>
          </ul>
          <template v-if="editable && mode === 'edit'">
            <div class="flex flex-wrap gap-2">
              <label class="sr-only" :for="`rag-${a.id}`">{{ a.label }} RAG</label>
              <select :id="`rag-${a.id}`" v-model="edit.rag[a.id].value" class="input w-auto">
                <option value="green">Green</option>
                <option value="amber">Amber</option>
                <option value="red">Red</option>
              </select>
              <label class="sr-only" :for="`rag-why-${a.id}`">Reason for the {{ a.label }} RAG</label>
              <input
                :id="`rag-why-${a.id}`"
                v-model="edit.rag[a.id].reason"
                class="input min-w-0 flex-1"
                maxlength="1000"
                :placeholder="overridden(a.id) ? 'Reason for the change (required)' : 'Note for the client (optional)'"
                :required="overridden(a.id)"
              />
            </div>
          </template>
          <p v-else-if="edit.rag[a.id].reason" class="text-sm">{{ edit.rag[a.id].reason }}</p>
        </div>
      </div>
    </section>

    <!-- preview -->
    <section v-if="mode === 'preview'" class="card p-4" aria-label="Report preview">
      <Markdown :text="bodyMd" />
      <p v-if="!bodyMd.trim()" class="text-sm text-slate-500">Nothing in this report yet.</p>
    </section>

    <!-- editor -->
    <template v-else>
      <section class="card space-y-2 p-3" aria-labelledby="sr-summary">
        <div class="flex flex-wrap items-center gap-2">
          <h3 id="sr-summary" class="text-sm font-semibold">Summary</h3>
          <button v-if="aiAvailable" class="btn btn-sm ml-auto" :disabled="busy" @click="aiDraft">Draft with AI</button>
        </div>
        <label class="sr-only" for="sr-summary-text">Summary</label>
        <textarea
          id="sr-summary-text"
          v-model="edit.summary"
          class="input"
          rows="4"
          maxlength="20000"
          placeholder="A few sentences for the client: what was achieved, what is next, the main risk. Markdown works."
        ></textarea>
      </section>

      <section v-for="s in sections" :key="s.id" class="card space-y-2 p-3" :aria-labelledby="`sr-h-${s.id}`">
        <div class="flex flex-wrap items-center gap-2">
          <h3 :id="`sr-h-${s.id}`" class="text-sm font-semibold">
            {{ s.label }}<template v-if="s.id === 'time' && edit.sections.time.total"> ({{ edit.sections.time.total }} h)</template>
          </h3>
          <label class="ml-auto flex items-center gap-1.5 text-xs text-slate-600"
            ><input v-model="edit.sections[s.id].internal" type="checkbox" /> Internal only (hidden from guests)</label
          >
          <label v-if="s.id === 'time'" class="flex items-center gap-1.5 text-xs text-slate-600"
            ><input v-model="edit.sections.time.hidden" type="checkbox" /> Leave out of the report</label
          >
        </div>
        <p v-if="!edit.sections[s.id].items.length && s.id !== 'decisions'" class="text-xs text-slate-500">
          {{
            s.id === 'topRisks' ? 'No open risks with a score of 12 or more in the RAID log.' : 'Nothing from the tracker for this period.'
          }}
        </p>
        <template v-for="g in groups(s.id, edit.sections[s.id].items)" :key="g.title || 'all'">
          <div v-if="g.title && groups(s.id, edit.sections[s.id].items).length > 1" class="text-xs font-semibold text-slate-600">
            {{ g.title }}
          </div>
          <ul class="divide-y divide-slate-100 rounded-lg border border-slate-200" v-if="g.items.length">
            <li v-for="x in g.items" :key="x.key || x.id || x.text || x.name" class="flex items-start gap-2 px-2 py-1.5 text-sm">
              <span class="min-w-0 flex-1 break-words">
                <RouterLink v-if="x.key" :to="`/browse/${x.key}`" class="link">{{ x.key }}</RouterLink>
                {{ itemText(s.id, x) }}
              </span>
              <span class="flex shrink-0 gap-0.5">
                <button
                  class="btn btn-ghost btn-sm"
                  :aria-label="`Move ${x.key || x.name || x.text} up`"
                  @click="move(s.id, edit.sections[s.id].items.indexOf(x), -1)"
                >
                  &uarr;
                </button>
                <button
                  class="btn btn-ghost btn-sm"
                  :aria-label="`Move ${x.key || x.name || x.text} down`"
                  @click="move(s.id, edit.sections[s.id].items.indexOf(x), 1)"
                >
                  &darr;
                </button>
                <button
                  class="btn btn-ghost btn-sm"
                  :aria-label="`Remove ${x.key || x.name || x.text}`"
                  @click="removeItem(s.id, edit.sections[s.id].items.indexOf(x))"
                >
                  &times;
                </button>
              </span>
            </li>
          </ul>
        </template>
        <form v-if="s.id === 'decisions'" class="flex gap-2" @submit.prevent="addDecision">
          <label class="sr-only" for="sr-decision">New decision needed</label>
          <input
            id="sr-decision"
            v-model="newDecision"
            class="input min-w-0 flex-1"
            maxlength="1000"
            placeholder="A decision the client needs to make"
          />
          <button class="btn btn-sm">Add</button>
        </form>
        <label class="sr-only" :for="`sr-text-${s.id}`">{{ s.label }} notes</label>
        <textarea
          :id="`sr-text-${s.id}`"
          v-model="edit.sections[s.id].text"
          class="input"
          rows="2"
          maxlength="20000"
          :placeholder="s.id === 'risks' ? 'Other risks and blockers (Markdown)' : 'Notes (Markdown, optional)'"
        ></textarea>
      </section>

      <section class="card p-3">
        <label class="flex items-start gap-2 text-sm"
          ><input v-model="edit.sharedWithGuests" type="checkbox" class="mt-0.5" />
          <span
            >Share with guests of this project (the client) once published. Sections marked internal only and the underlying numbers stay
            hidden from them.</span
          ></label
        >
      </section>
    </template>
  </template>
</template>
