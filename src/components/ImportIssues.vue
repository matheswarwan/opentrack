<script setup>
import { ref, computed, onMounted } from 'vue';
import { get, post } from '../api.js';
import { downloadText } from '../browser.js';
import { parseCsv, guessMapping, mapRows, fieldTargets, IMPORT_FIELDS, TEMPLATE_CSV } from '../csv.js';
import Modal from './Modal.vue';

const props = defineProps({ projectKey: { type: String, required: true } });
const emit = defineEmits(['close', 'imported']);
const MAX_ROWS = 500;

const step = ref('source'); // source | map | preview | done
const text = ref('');
const fileName = ref('');
const parsed = ref([]); // rows of cells, first = header
const mapping = ref({});
const check = ref(null); // dryRun result
const created = ref([]);
const busy = ref(false);
const error = ref('');

const header = computed(() => parsed.value[0] || []);
const dataCount = computed(() => Math.max(parsed.value.length - 1, 0));
// the project's custom fields are import targets too (key 'cf:<fieldId>')
const extra = ref([]);
onMounted(async () => {
  try {
    extra.value = fieldTargets((await get(`/api/projects/${props.projectKey}/fields`)).fields);
  } catch {
    /* none */
  }
});
const apiRows = computed(() => mapRows(parsed.value, mapping.value, extra.value));
const unused = computed(() => header.value.filter((_, i) => !Object.values(mapping.value).includes(i)));

async function readFile(e) {
  const f = e.target.files[0];
  if (!f) return;
  fileName.value = f.name;
  text.value = await f.text();
}

const downloadTemplate = () => downloadText('issue-import-template.csv', TEMPLATE_CSV, 'text/csv');

function toMapping() {
  error.value = '';
  parsed.value = parseCsv(text.value);
  if (parsed.value.length < 2) {
    error.value = 'Add a header row and at least one issue.';
    return;
  }
  if (dataCount.value > MAX_ROWS) {
    error.value = `This file has ${dataCount.value} rows. Import at most ${MAX_ROWS} at a time.`;
    return;
  }
  mapping.value = guessMapping(header.value, parsed.value.slice(1), extra.value);
  step.value = 'map';
}

async function toPreview() {
  error.value = '';
  if (mapping.value.title < 0) {
    error.value = 'Choose the column that holds the title.';
    return;
  }
  busy.value = true;
  try {
    check.value = await post(`/api/projects/${props.projectKey}/import`, { rows: apiRows.value, dryRun: true });
    step.value = 'preview';
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function runImport() {
  error.value = '';
  busy.value = true;
  try {
    const r = await post(`/api/projects/${props.projectKey}/import`, { rows: apiRows.value });
    created.value = r.created;
    step.value = 'done';
    emit('imported');
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

const preview = computed(() => (check.value?.rows || []).map((r, i) => ({ ...r, data: apiRows.value[i] || {} })));
const title = computed(
  () =>
    ({ source: 'Import issues', map: 'Import issues: match columns', preview: 'Import issues: check', done: 'Import finished' })[
      step.value
    ],
);
</script>
<template>
  <Modal :title="title" wide @close="emit('close')">
    <template v-if="step === 'source'">
      <p class="mb-2 text-sm text-slate-600">
        Paste CSV or choose a .csv or .tsv file. The first row must hold the column names. A CSV exported from Jira works too. Up to
        {{ MAX_ROWS }} issues at a time.
        <button type="button" class="link" @click="downloadTemplate">Download a template CSV</button>
      </p>
      <textarea
        v-model="text"
        rows="10"
        class="input font-mono text-xs"
        placeholder="title,type,priority,assignee&#10;Fix login bug,bug,high,jane@example.com"
        aria-label="CSV text"
      ></textarea>
      <div class="mt-2 flex items-center gap-2 text-sm">
        <input type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values" class="text-sm" @change="readFile" />
        <span v-if="fileName" class="text-slate-500">{{ fileName }}</span>
      </div>
    </template>

    <template v-else-if="step === 'map'">
      <p class="mb-3 text-sm text-slate-600">
        {{ dataCount }} rows found. Check which column goes into each field. Columns you do not pick are ignored.
      </p>
      <div class="grid gap-2 sm:grid-cols-2">
        <div v-for="f in IMPORT_FIELDS" :key="f.key">
          <label class="label" :for="'imp-' + f.key">{{ f.label }}<span v-if="f.required"> (required)</span></label>
          <select :id="'imp-' + f.key" v-model.number="mapping[f.key]" class="input">
            <option :value="-1">Not imported</option>
            <option v-for="(h, i) in header" :key="i" :value="i">{{ h || `Column ${i + 1}` }}</option>
          </select>
        </div>
      </div>
      <template v-if="extra.length">
        <h3 class="mb-1 mt-4 text-sm font-semibold">Fields of this project</h3>
        <div class="grid gap-2 sm:grid-cols-2">
          <div v-for="f in extra" :key="f.key">
            <label class="label" :for="'imp-' + f.key">{{ f.label }}<span v-if="f.required"> (required)</span></label>
            <select :id="'imp-' + f.key" v-model.number="mapping[f.key]" class="input">
              <option :value="-1">Not imported</option>
              <option v-for="(h, i) in header" :key="i" :value="i">{{ h || `Column ${i + 1}` }}</option>
            </select>
          </div>
        </div>
        <p class="mt-2 text-xs text-slate-500">
          Options by name; several options separated by commas. Checkboxes: yes or no. People: email or name. Dates: YYYY-MM-DD.
        </p>
      </template>
      <p v-if="unused.length" class="mt-3 text-xs text-slate-500">Ignored columns: {{ unused.join(', ') }}</p>
      <p class="mt-2 text-xs text-slate-500">
        Type: epic, story, task, bug or sub-task (default task). Priority: highest to lowest (default medium). Labels: separated by spaces
        or commas. Parent: an issue key in this project, or #3 for the third row of this file. Status and sprint: the name as it appears in
        this project. Due date: YYYY-MM-DD. Components and fix versions: names separated by commas (Jira's repeated Component/s and Fix
        Version/s columns work too). Names the project does not have are created when a project admin imports.
      </p>
    </template>

    <template v-else-if="step === 'preview'">
      <p class="mb-2 text-sm" :class="check.valid ? 'text-green-700' : 'text-red-700'">
        {{
          check.valid
            ? `All ${preview.length} rows are ready to import.`
            : `${check.invalidRows} of ${preview.length} rows have errors. Fix them in the file and try again, or change the column choices.`
        }}
      </p>
      <div class="max-h-96 overflow-auto rounded border border-slate-200">
        <table class="w-full text-sm">
          <thead class="sticky top-0 bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th class="px-2 py-1.5">Row</th>
              <th class="px-2 py-1.5">Title</th>
              <th class="px-2 py-1.5">Type</th>
              <th class="px-2 py-1.5">Assignee</th>
              <th class="px-2 py-1.5">Status</th>
              <th class="px-2 py-1.5">Parent</th>
              <th class="px-2 py-1.5">Check</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in preview" :key="r.row" class="border-t border-slate-100 align-top" :class="r.errors.length ? 'bg-red-50' : ''">
              <td class="px-2 py-1.5 text-slate-500">{{ r.row }}</td>
              <td class="px-2 py-1.5">{{ r.data.title }}</td>
              <td class="px-2 py-1.5">{{ r.data.type || 'task' }}</td>
              <td class="px-2 py-1.5">{{ r.data.assignee }}</td>
              <td class="px-2 py-1.5">{{ r.data.status }}</td>
              <td class="px-2 py-1.5">{{ r.data.parent }}</td>
              <td class="px-2 py-1.5">
                <span v-if="!r.errors.length" class="text-green-700">OK</span>
                <ul v-else class="text-red-700">
                  <li v-for="(e, i) in r.errors" :key="i">{{ e }}</li>
                </ul>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <template v-else>
      <p class="mb-2 text-sm">
        Created {{ created.length }} issues<span v-if="created.length">: {{ created[0].key }} to {{ created[created.length - 1].key }}</span
        >.
      </p>
      <div class="flex max-h-60 flex-wrap gap-1.5 overflow-y-auto">
        <RouterLink v-for="c in created" :key="c.key" :to="`/browse/${c.key}`" class="chip">{{ c.key }}</RouterLink>
      </div>
    </template>

    <p v-if="error" class="mt-2 text-sm text-red-700">{{ error }}</p>

    <template #footer>
      <template v-if="step === 'source'">
        <button class="btn" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" :disabled="!text.trim()" @click="toMapping">Next</button>
      </template>
      <template v-else-if="step === 'map'">
        <button class="btn" @click="step = 'source'">Back</button>
        <button class="btn btn-primary" :disabled="busy" @click="toPreview">{{ busy ? 'Checking...' : 'Check rows' }}</button>
      </template>
      <template v-else-if="step === 'preview'">
        <button class="btn" @click="step = 'map'">Back</button>
        <button class="btn btn-primary" :disabled="busy || !check.valid" @click="runImport">
          {{ busy ? 'Importing...' : `Import ${preview.length} issues` }}
        </button>
      </template>
      <button v-else class="btn btn-primary" @click="emit('close')">Done</button>
    </template>
  </Modal>
</template>
