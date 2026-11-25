<script setup>
// Report builder: pick the issues (saved filter, project or quick fields), the report type and its
// options, see a live preview, then save it (private or shared). Also edits a saved report.
import { ref, computed, watch, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { get, post, patch, toast, users as loadUsers } from '../../api.js';
import {
  KINDS,
  FIELDS,
  METRICS,
  COLUMNS,
  SORTS,
  defaultOptions,
  fieldLabel,
  kindOf,
  blankSourceForm,
  sourceOf,
  sourceFormOf,
  sourceProjectOf,
} from '../../reports.js';
import ReportResult from '../../components/reports/ReportResult.vue';
import ReportSource from '../../components/reports/ReportSource.vue';
import { GROUPABLE } from '../../fields.js';
import { projectList } from '../../projects.js';
import { attempt } from '../../composables/useAction.js';

const route = useRoute();
const router = useRouter();
const editId = computed(() => route.params.id || null);
const dashboardId = computed(() => route.query.dashboard || null);

const filters = ref([]);
const projects = ref([]);
const people = ref([]);
const loaded = ref(false);

const src = ref(blankSourceForm()); // step 1, the v-model of <ReportSource>
const kind = ref('breakdown');
const options = ref(defaultOptions('breakdown'));
const name = ref('');
const description = ref('');
const visibility = ref('private');
const saving = ref(false);

const DAY_CHOICES = [7, 14, 30, 60, 90, 180, 365, 730];
const dayChoices = computed(() => DAY_CHOICES.filter((d) => options.value.period !== 'day' || d <= 180));

function pickKind(k) {
  if (k === kind.value) return;
  kind.value = k;
  options.value = defaultOptions(k);
}
watch(
  () => options.value.period,
  (p) => {
    if (p === 'day' && options.value.days > 180) options.value.days = 180;
  },
);

const source = computed(() => sourceOf(src.value));
const def = computed(() => (source.value ? { source: source.value, kind: kind.value, options: options.value } : null));

// group by custom fields (select, multi-select, person, checkbox) of the one project the report covers: 'cf:<fieldId>'
const sourceProject = computed(() => sourceProjectOf(src.value));
const cfFields = ref([]);
watch(
  sourceProject,
  async (key) => {
    cfFields.value = [];
    if (!key) return;
    try {
      const list = (await get(`/api/projects/${key}/fields`)).fields.filter((f) => !f.archived && GROUPABLE.includes(f.type));
      if (sourceProject.value === key) cfFields.value = list;
    } catch {
      /* no access */
    }
  },
  { immediate: true },
);
const groupFields = computed(() => {
  const list = [...FIELDS, ...cfFields.value.map((f) => ({ id: `cf:${f.id}`, label: f.name }))];
  for (const id of [options.value.groupBy, options.value.rows, options.value.columns]) {
    if (id && id.startsWith('cf:') && !list.some((x) => x.id === id))
      list.push({ id, label: preview.value?.groupLabel && options.value.groupBy === id ? preview.value.groupLabel : 'Custom field' });
  }
  return list;
});
const labelOf = (id) => groupFields.value.find((f) => f.id === id)?.label || fieldLabel(id);

// ---- live preview ----
const preview = ref(null);
const previewError = ref('');
const previewing = ref(false);
let timer = null;
let seq = 0;
watch(
  def,
  (d) => {
    clearTimeout(timer);
    if (!d || !loaded.value) return;
    timer = setTimeout(async () => {
      const mine = ++seq;
      previewing.value = true;
      try {
        const r = await post('/api/report-data', d);
        if (mine === seq) {
          preview.value = r;
          previewError.value = '';
        }
      } catch (e) {
        if (mine === seq) {
          previewError.value = e.message;
          preview.value = null;
        }
      }
      if (mine === seq) previewing.value = false;
    }, 350);
  },
  { deep: true },
);

const suggestedName = computed(() => {
  const o = options.value;
  switch (kind.value) {
    case 'breakdown':
      return `Issues by ${labelOf(o.groupBy).toLowerCase()}`;
    case 'twoD':
      return `${labelOf(o.rows)} by ${labelOf(o.columns).toLowerCase()}`;
    case 'createdVsResolved':
      return `Created vs resolved, last ${o.days} days`;
    case 'averageAge':
      return `Average age, last ${o.days} days`;
    default:
      return kindOf(kind.value).label;
  }
});

onMounted(async () => {
  try {
    [filters.value, projects.value, people.value] = await Promise.all([
      get('/api/filters').then((r) => r.filters),
      projectList(),
      loadUsers(),
    ]);
    if (editId.value) {
      const r = (await get(`/api/saved-reports/${editId.value}`)).report;
      if (!r.canEdit) {
        router.replace(`/reports/${r.id}`);
        return;
      }
      name.value = r.name;
      description.value = r.description;
      visibility.value = r.visibility;
      kind.value = r.kind;
      options.value = { ...defaultOptions(r.kind), ...r.options };
      src.value = sourceFormOf(r.source);
    } else if (route.query.project) {
      src.value.mode = 'project';
      src.value.projectKey = String(route.query.project);
    } else {
      src.value.quick.category = 'todo,in_progress';
    }
  } catch (e) {
    toast(e.message, 'error');
  }
  loaded.value = true;
  // first preview straight away
  if (def.value) {
    try {
      preview.value = await post('/api/report-data', def.value);
    } catch (e) {
      previewError.value = e.message;
    }
  }
});

const sharedFilterProblem = computed(() => {
  if (src.value.mode !== 'filter' || visibility.value !== 'shared' || !src.value.filterId) return false;
  const f = filters.value.find((x) => x.id === src.value.filterId);
  return f && !f.shared;
});

async function save() {
  if (!def.value) {
    toast('Pick a saved filter first', 'error');
    return;
  }
  saving.value = true;
  await attempt(async () => {
    const payload = {
      ...def.value,
      name: name.value.trim() || suggestedName.value,
      description: description.value,
      visibility: visibility.value,
    };
    const r = editId.value
      ? (await patch(`/api/saved-reports/${editId.value}`, payload)).report
      : (await post('/api/saved-reports', payload)).report;
    if (dashboardId.value && !editId.value) {
      const d = (await get(`/api/dashboards/${dashboardId.value}`)).dashboard;
      const layout = [
        ...d.layout.map((x) => ({ reportId: x.reportId, width: x.width })),
        { reportId: r.id, width: r.kind === 'list' || r.kind === 'createdVsResolved' ? 'full' : 'half' },
      ];
      await patch(`/api/dashboards/${d.id}`, { layout });
      toast('Report saved and added to the dashboard');
      router.push(`/reports/dashboards/${d.id}`);
    } else {
      toast('Report saved');
      router.push(`/reports/${r.id}`);
    }
  });
  saving.value = false;
}
function toggleColumn(id) {
  const cols = options.value.columns;
  options.value.columns = cols.includes(id)
    ? cols.filter((c) => c !== id)
    : COLUMNS.map((c) => c.id).filter((c) => c === id || cols.includes(c));
}
</script>
<template>
  <div class="mx-auto max-w-6xl space-y-4 pb-10">
    <div>
      <RouterLink to="/reports?tab=reports" class="text-xs text-slate-500 hover:underline">Reports</RouterLink>
      <h1 class="text-xl font-semibold">{{ editId ? 'Edit report' : 'New report' }}</h1>
    </div>

    <div class="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <div class="min-w-0 space-y-4">
        <!-- 1. source -->
        <ReportSource v-model:form="src" :filters="filters" :projects="projects" :people="people" />

        <!-- 2. type -->
        <section class="card space-y-3 p-4" aria-labelledby="b-kind">
          <h2 id="b-kind" class="font-semibold">2. Report type</h2>
          <div class="grid grid-cols-2 gap-2">
            <button
              v-for="k in KINDS"
              :key="k.id"
              type="button"
              class="flex flex-col items-start gap-1 rounded-lg border p-2 text-left text-xs"
              :class="kind === k.id ? 'border-black bg-surface' : 'border-slate-200 hover:border-slate-400'"
              :aria-pressed="kind === k.id"
              @click="pickKind(k.id)"
            >
              <svg width="44" height="28" viewBox="0 0 44 28" aria-hidden="true">
                <template v-if="k.id === 'breakdown'">
                  <circle cx="14" cy="14" r="10" fill="none" stroke="#e4e7ee" stroke-width="6" />
                  <circle
                    cx="14"
                    cy="14"
                    r="10"
                    fill="none"
                    stroke="#4f46e5"
                    stroke-width="6"
                    stroke-dasharray="38 63"
                    transform="rotate(-90 14 14)"
                  />
                  <rect x="30" y="16" width="4" height="10" fill="#0d9488" />
                  <rect x="36" y="8" width="4" height="18" fill="#4f46e5" />
                </template>
                <template v-else-if="k.id === 'twoD'">
                  <rect x="2" y="2" width="40" height="24" fill="none" stroke="#a29a95" />
                  <path d="M2 10h40M2 18h40M16 2v24M29 2v24" stroke="#a29a95" />
                  <rect x="16" y="10" width="13" height="8" fill="#4f46e5" opacity=".5" />
                </template>
                <template v-else-if="k.id === 'createdVsResolved'">
                  <polyline points="2,22 12,16 22,18 32,8 42,6" fill="none" stroke="#4f46e5" stroke-width="2" />
                  <polyline points="2,25 12,22 22,14 32,14 42,10" fill="none" stroke="#0d9488" stroke-width="2" />
                </template>
                <template v-else-if="k.id === 'averageAge'">
                  <polyline points="2,20 12,18 22,12 32,13 42,6" fill="none" stroke="#4f46e5" stroke-width="2" />
                  <path d="M2 26h40" stroke="#e4e7ee" />
                </template>
                <template v-else-if="k.id === 'workload'">
                  <rect x="2" y="3" width="34" height="5" fill="#4f46e5" />
                  <rect x="2" y="11" width="24" height="5" fill="#4f46e5" />
                  <rect x="2" y="19" width="12" height="5" fill="#a29a95" />
                </template>
                <template v-else><path d="M2 5h8M14 5h28M2 13h8M14 13h22M2 21h8M14 21h26" stroke="#57534e" stroke-width="2" /></template>
              </svg>
              <span class="font-semibold text-black">{{ k.label }}</span>
              <span class="text-slate-500">{{ k.description }}</span>
            </button>
          </div>
        </section>

        <!-- 3. options -->
        <section class="card space-y-3 p-4" aria-labelledby="b-opts">
          <h2 id="b-opts" class="font-semibold">3. Options</h2>
          <template v-if="kind === 'breakdown'">
            <label class="block"
              ><span class="label">Group by</span
              ><select v-model="options.groupBy" class="input">
                <option v-for="f in groupFields" :key="f.id" :value="f.id">{{ f.label }}</option>
              </select></label
            >
            <label class="block"
              ><span class="label">Measure</span
              ><select v-model="options.metric" class="input">
                <option v-for="m in METRICS" :key="m.id" :value="m.id">{{ m.label }}</option>
              </select></label
            >
            <div>
              <span class="label">Show as</span>
              <div class="flex rounded-full border border-slate-300 p-0.5 text-xs" role="group" aria-label="Show as">
                <button
                  v-for="c in [
                    { id: 'pie', label: 'Pie' },
                    { id: 'bar', label: 'Bar' },
                    { id: 'table', label: 'Table' },
                  ]"
                  :key="c.id"
                  type="button"
                  class="flex-1 rounded-full px-2.5 py-1 font-medium"
                  :class="options.chart === c.id ? 'bg-black text-white' : 'text-slate-600 hover:bg-slate-100'"
                  :aria-pressed="options.chart === c.id"
                  @click="options.chart = c.id"
                >
                  {{ c.label }}
                </button>
              </div>
            </div>
          </template>
          <template v-else-if="kind === 'twoD'">
            <label class="block"
              ><span class="label">Rows</span
              ><select v-model="options.rows" class="input">
                <option v-for="f in groupFields" :key="f.id" :value="f.id" :disabled="f.id === options.columns">{{ f.label }}</option>
              </select></label
            >
            <label class="block"
              ><span class="label">Columns</span
              ><select v-model="options.columns" class="input">
                <option v-for="f in groupFields" :key="f.id" :value="f.id" :disabled="f.id === options.rows">{{ f.label }}</option>
              </select></label
            >
            <label class="block"
              ><span class="label">Measure</span
              ><select v-model="options.metric" class="input">
                <option v-for="m in METRICS" :key="m.id" :value="m.id">{{ m.label }}</option>
              </select></label
            >
          </template>
          <template v-else-if="kind === 'createdVsResolved' || kind === 'averageAge'">
            <div class="grid grid-cols-2 gap-2">
              <label
                ><span class="label">Per</span
                ><select v-model="options.period" class="input">
                  <option value="day">Day</option>
                  <option value="week">Week</option>
                  <option value="month">Month</option>
                </select></label
              >
              <label
                ><span class="label">Period</span
                ><select v-model.number="options.days" class="input">
                  <option v-for="d in dayChoices" :key="d" :value="d">Last {{ d }} days</option>
                </select></label
              >
            </div>
            <template v-if="kind === 'createdVsResolved'">
              <label class="flex items-center gap-2 text-sm"><input v-model="options.cumulative" type="checkbox" /> Running totals</label>
              <label class="block"
                ><span class="label">Show as</span
                ><select v-model="options.chart" class="input">
                  <option value="line">Lines</option>
                  <option value="bar">Bars</option>
                </select></label
              >
            </template>
          </template>
          <template v-else-if="kind === 'workload'">
            <label class="flex items-center gap-2 text-sm"
              ><input v-model="options.includeDone" type="checkbox" /> Include done issues</label
            >
            <p class="text-xs text-slate-500">Open issues, story points, estimated and logged hours per assignee.</p>
          </template>
          <template v-else-if="kind === 'list'">
            <div class="grid grid-cols-2 gap-2">
              <label
                ><span class="label">Sort by</span
                ><select v-model="options.sort" class="input">
                  <option v-for="s in SORTS" :key="s.id" :value="s.id">{{ s.label }}</option>
                </select></label
              >
              <label
                ><span class="label">Order</span
                ><select v-model="options.dir" class="input">
                  <option value="desc">Newest or highest first</option>
                  <option value="asc">Oldest or lowest first</option>
                </select></label
              >
              <label
                ><span class="label">Show</span
                ><select v-model.number="options.limit" class="input">
                  <option v-for="n in [5, 10, 15, 25, 50, 100]" :key="n" :value="n">{{ n }} issues</option>
                </select></label
              >
            </div>
            <fieldset>
              <legend class="label">Columns</legend>
              <div class="grid grid-cols-2 gap-x-2 gap-y-1 text-sm">
                <label v-for="c in COLUMNS" :key="c.id" class="flex items-center gap-2"
                  ><input
                    type="checkbox"
                    :checked="options.columns.includes(c.id)"
                    :disabled="options.columns.length === 1 && options.columns.includes(c.id)"
                    @change="toggleColumn(c.id)"
                  />
                  {{ c.label }}</label
                >
              </div>
            </fieldset>
          </template>
        </section>
      </div>

      <div class="min-w-0 space-y-4">
        <!-- preview -->
        <section class="card min-w-0 p-4" aria-labelledby="b-prev" aria-live="polite">
          <div class="mb-2 flex items-center gap-2">
            <h2 id="b-prev" class="min-w-0 flex-1 font-semibold">Preview</h2>
            <span v-if="previewing" class="text-xs text-slate-500">Updating...</span>
          </div>
          <p v-if="!source" class="py-10 text-center text-sm text-slate-500">Choose a saved filter to see a preview.</p>
          <p v-else-if="previewError" class="py-10 text-center text-sm text-red-700">{{ previewError }}</p>
          <p v-else-if="!preview" class="py-10 text-center text-sm text-slate-500">Loading...</p>
          <ReportResult v-else :result="preview" :title="name || suggestedName" />
        </section>

        <!-- save -->
        <section class="card space-y-3 p-4" aria-labelledby="b-save">
          <h2 id="b-save" class="font-semibold">4. Save</h2>
          <label class="block"
            ><span class="label">Name</span><input v-model="name" class="input" maxlength="100" :placeholder="suggestedName"
          /></label>
          <label class="block"
            ><span class="label">Description (optional)</span><input v-model="description" class="input" maxlength="1000"
          /></label>
          <fieldset class="flex flex-wrap gap-4 text-sm">
            <legend class="label">Who can see it</legend>
            <label class="flex items-center gap-2"><input v-model="visibility" type="radio" value="private" /> Only me</label>
            <label class="flex items-center gap-2"
              ><input v-model="visibility" type="radio" value="shared" /> Everyone (each person sees only issues they can see)</label
            >
          </fieldset>
          <p v-if="sharedFilterProblem" class="text-xs text-red-700">
            This saved filter is private. Share the filter first, or use "Issues matching".
          </p>
          <div class="flex flex-wrap gap-2">
            <button type="button" class="btn btn-primary" :disabled="saving || !source || sharedFilterProblem" @click="save">
              {{ saving ? 'Saving...' : dashboardId && !editId ? 'Save and add to dashboard' : 'Save report' }}
            </button>
            <RouterLink :to="editId ? `/reports/${editId}` : '/reports?tab=reports'" class="btn">Cancel</RouterLink>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
