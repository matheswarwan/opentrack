<script setup>
// Admin > Import from Jira: connect with an API token, choose projects and options, dry run, then run the import
// in steps (this page keeps calling /step while it is open). Server: server/routes/jiraImport.js.
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { get, post, put, toast } from '../../api.js';
import { fmtDateTime } from '../../meta.js';
import { attempt } from '../../composables/useAction.js';
import { useLoad } from '../../composables/useLoad.js';
import LoadState from '../../components/LoadState.vue';

const imp = ref(null); // the import on screen
const projects = ref([]); // [{ id, key, name, targetKey, keyFree, chosen }]
const form = ref({ site: '', email: '', token: '' });
const options = ref({ comments: true, closedSprints: false, attachments: true, worklogs: false, createUsers: false });
const busy = ref(false);
const driving = ref(false);
let stopped = false;

const STAGES = {
  fields: 'Reading Jira fields',
  scan: 'Counting issues',
  users: 'Matching people',
  project: 'Creating the project',
  sprints: 'Copying sprints',
  issues: 'Copying issues',
  parents: 'Linking parents',
  attachments: 'Copying files',
  finish: 'Finishing',
};
const STATUS = {
  connected: 'Connected',
  planned: 'Projects chosen',
  running: 'Running',
  waiting: 'Waiting for Jira',
  ready: 'Dry run done',
  done: 'Finished',
  cancelled: 'Cancelled',
  error: 'Stopped with an error',
};
const active = computed(() => imp.value && ['running', 'waiting'].includes(imp.value.status));
const choosing = computed(() => imp.value && ['connected', 'planned', 'ready'].includes(imp.value.status));
const chosen = computed(() => projects.value.filter((p) => p.chosen));
const size = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const {
  data: imports,
  loading,
  error: loadError,
  reload: loadList,
} = useLoad(async () => (await get('/api/admin/jira-import')).imports, null, { manual: true }); // loaded in onMounted below
async function open(id) {
  const r = (await get(`/api/admin/jira-import/${id}`)).import;
  show(r);
  if (r.plan) {
    const plan = new Map(r.plan.projects.map((p) => [p.jiraKey, p.targetKey]));
    for (const p of projects.value) {
      p.chosen = plan.has(p.key);
      if (plan.has(p.key)) p.targetKey = plan.get(p.key);
    }
  }
  if (r.options) options.value = { ...r.options };
}
function show(r) {
  imp.value = r;
  if (r.jiraProjects?.length && (!projects.value.length || projects.value[0].importId !== r.id)) {
    projects.value = r.jiraProjects.map((p) => ({ ...p, importId: r.id, chosen: false, targetKey: p.targetKey || p.key }));
  }
}
onMounted(async () => {
  await attempt(async () => {
    await loadList();
    const current = (imports.value || []).find(
      (x) => ['connected', 'planned', 'ready', 'running', 'waiting'].includes(x.status) && x.hasCredentials,
    );
    if (current) await open(current.id);
  });
});
onUnmounted(() => {
  stopped = true;
});

async function connect() {
  busy.value = true;
  await attempt(async () => {
    const r = await post('/api/admin/jira-import/connect', form.value);
    form.value.token = '';
    projects.value = r.projects.map((p) => ({ ...p, importId: r.import.id, chosen: false }));
    imp.value = r.import;
    loadList();
  });
  busy.value = false;
}

async function savePlan() {
  const r = await put(`/api/admin/jira-import/${imp.value.id}/plan`, {
    projects: chosen.value.map((p) => ({ jiraKey: p.key, targetKey: p.targetKey })),
    options: options.value,
  });
  imp.value = { ...imp.value, ...r.import };
}

async function begin(kind) {
  if (!chosen.value.length) return toast('Choose at least one project', 'error');
  busy.value = true;
  await attempt(async () => {
    await savePlan();
    const r = await post(`/api/admin/jira-import/${imp.value.id}/${kind}`);
    imp.value = { ...imp.value, ...r.import };
    drive();
  });
  busy.value = false;
}
async function startImport() {
  busy.value = true;
  await attempt(async () => {
    const r = await post(`/api/admin/jira-import/${imp.value.id}/start`);
    imp.value = { ...imp.value, ...r.import };
    drive();
  });
  busy.value = false;
}

/** Call /step until the run stops, waiting out Jira's rate limits. */
async function drive() {
  if (driving.value) return;
  driving.value = true;
  stopped = false;
  try {
    while (!stopped && imp.value && ['running', 'waiting'].includes(imp.value.status)) {
      if (imp.value.status === 'waiting' && imp.value.retryAt) {
        const wait = new Date(imp.value.retryAt).getTime() - Date.now();
        if (wait > 0) await sleep(Math.min(wait + 200, 60000));
      }
      const r = await post(`/api/admin/jira-import/${imp.value.id}/step`);
      imp.value = { ...imp.value, ...r.import };
      if (r.busy) await sleep(2000);
    }
  } catch (e) {
    toast(`${e.message}. Press Continue to try again.`, 'error');
  }
  driving.value = false;
  if (imp.value && ['done', 'error'].includes(imp.value.status)) loadList();
}

async function cancel() {
  if (!confirm('Cancel this import? What was already copied stays. The Jira token is deleted.')) return;
  stopped = true;
  await attempt(async () => {
    const r = await post(`/api/admin/jira-import/${imp.value.id}/cancel`);
    imp.value = { ...imp.value, ...r.import };
    loadList();
  });
}
function newImport() {
  stopped = true;
  imp.value = null;
  projects.value = [];
}

const progressRows = computed(() => {
  const p = imp.value?.progress;
  if (!p) return [];
  return [
    ['Projects', p.projects],
    ['Statuses', p.statuses],
    ['Sprints', p.sprints],
    ['Issues', p.issues],
    ['Comments', p.comments],
    ['Links', p.links],
    ['Work logs', p.worklogs],
    ['Files copied', p.attachments],
    ['Files skipped', p.attachmentsSkipped],
    ['People invited', p.usersCreated],
    ['Problems', p.errors],
  ].filter(([, v]) => v !== undefined);
});
const planChanged = computed(() => {
  const plan = imp.value?.plan?.projects || [];
  const now = chosen.value
    .map((p) => `${p.key}:${p.targetKey.toUpperCase()}`)
    .sort()
    .join();
  return (
    now !==
      plan
        .map((p) => `${p.jiraKey}:${p.targetKey}`)
        .sort()
        .join() || JSON.stringify(options.value) !== JSON.stringify({ ...options.value, ...(imp.value?.options || {}) })
  );
});
const totalIssues = computed(() => imp.value?.dryRun?.totals?.issues || 0);
</script>

<template>
  <LoadState v-if="!imports" :loading="loading" :error="loadError" card :rows="4" @retry="loadList" />
  <div v-else class="max-w-3xl space-y-4">
    <!-- Step 1: connect -->
    <div v-if="!imp" class="card space-y-3 p-4">
      <h2 class="text-sm font-semibold">Import from Jira Cloud</h2>
      <p class="text-sm text-slate-600">
        Copies Jira projects into new projects here: statuses, sprints, issues (epics, stories, tasks, bugs, sub-tasks), descriptions,
        comments, links, labels, story points, estimates and, if you want, work logs and files up to 10 MB. Nothing in Jira is changed.
      </p>
      <label class="block text-sm"
        >Jira site
        <input v-model="form.site" class="input mt-1" placeholder="https://yourcompany.atlassian.net" autocomplete="off" />
      </label>
      <label class="block text-sm"
        >Your Jira email
        <input v-model="form.email" class="input mt-1" type="email" autocomplete="off" />
      </label>
      <label class="block text-sm"
        >API token
        <input v-model="form.token" class="input mt-1" type="password" autocomplete="new-password" />
      </label>
      <p class="text-xs text-slate-500">
        Create a token at
        <a class="underline" href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener"
          >id.atlassian.com</a
        >
        (Security, then Create and manage API tokens). Use an account that can see every project you want to import. The token is kept on
        the server only while the import runs. It is deleted when the import finishes or is cancelled (or after a day without activity), and
        it is never shown again.
      </p>
      <button class="btn btn-primary" :disabled="busy || !form.site || !form.email || !form.token" @click="connect">
        {{ busy ? 'Connecting...' : 'Connect' }}
      </button>
    </div>

    <template v-else>
      <div class="card flex flex-wrap items-center gap-x-3 gap-y-1 p-4 text-sm">
        <span class="font-semibold">{{ imp.site }}</span>
        <span v-if="imp.jiraUser" class="text-slate-500">as {{ imp.jiraUser }}</span>
        <span class="rounded-full bg-slate-100 px-2 py-0.5 text-xs">{{ STATUS[imp.status] || imp.status }}</span>
        <span class="ml-auto flex gap-2">
          <button v-if="!['done', 'cancelled', 'error'].includes(imp.status)" class="btn btn-sm btn-danger" @click="cancel">Cancel</button>
          <button v-if="!active || !driving" class="btn btn-sm" @click="newImport">New import</button>
        </span>
      </div>

      <!-- Step 2: choose -->
      <div v-if="choosing" class="card space-y-3 p-4">
        <h2 class="text-sm font-semibold">Choose projects</h2>
        <p class="text-xs text-slate-500">
          Each Jira project becomes a new project. When the key stays the same, issues keep their Jira numbers (WEB-12 stays WEB-12); with
          another key they are numbered again in order.
        </p>
        <p v-if="!projects.length" class="text-sm text-slate-500">This Jira account sees no projects.</p>
        <ul class="divide-y divide-slate-100">
          <li v-for="p in projects" :key="p.id" class="flex flex-wrap items-center gap-2 py-2 text-sm">
            <label class="flex min-w-0 flex-1 items-center gap-2">
              <input v-model="p.chosen" type="checkbox" />
              <span class="font-mono text-xs">{{ p.key }}</span>
              <span class="truncate">{{ p.name }}</span>
            </label>
            <span v-if="p.chosen" class="flex items-center gap-1">
              <span class="text-xs text-slate-500">New key</span>
              <input v-model="p.targetKey" class="input w-28 font-mono uppercase" maxlength="10" />
            </span>
            <span v-if="p.chosen" class="w-full text-xs" :class="p.targetKey.toUpperCase() === p.key ? 'text-green-700' : 'text-slate-500'">
              {{
                p.targetKey.toUpperCase() === p.key
                  ? 'Keeps Jira numbers'
                  : p.keyFree
                    ? 'Numbered again'
                    : `${p.key} is already used here, so numbered again`
              }}
            </span>
          </li>
        </ul>
        <fieldset class="space-y-1.5 text-sm">
          <legend class="mb-1 text-sm font-semibold">Options</legend>
          <label class="flex items-start gap-2"
            ><input v-model="options.comments" type="checkbox" class="mt-1" /> Comments (original author and time)</label
          >
          <label class="flex items-start gap-2"
            ><input v-model="options.closedSprints" type="checkbox" class="mt-1" /> Closed sprints (otherwise only active and future
            sprints)</label
          >
          <label class="flex items-start gap-2"
            ><input v-model="options.attachments" type="checkbox" class="mt-1" /> Files attached to issues, up to 10 MB each (bigger files
            are listed as skipped)</label
          >
          <label class="flex items-start gap-2"><input v-model="options.worklogs" type="checkbox" class="mt-1" /> Work logs</label>
          <label class="flex items-start gap-2"
            ><input v-model="options.createUsers" type="checkbox" class="mt-1" /> Invite people who are not users here yet (only those whose
            email Jira shows). Otherwise their issues are left unassigned.</label
          >
        </fieldset>
        <p class="text-xs text-slate-500">
          People are matched to users here by email. Jira shows an email only when the person allows it; otherwise the name must match
          exactly one user.
        </p>
        <div class="flex flex-wrap gap-2">
          <button class="btn" :disabled="busy || driving || !chosen.length" @click="begin('dry-run')">Dry run</button>
          <button
            class="btn btn-primary"
            :disabled="busy || driving || !chosen.length"
            @click="imp.status === 'ready' && !planChanged ? startImport() : begin('start')"
          >
            Start import
          </button>
        </div>
      </div>

      <!-- Dry run -->
      <div v-if="imp.dryRun?.done && imp.mode === 'dryrun'" class="card space-y-3 p-4 text-sm">
        <h2 class="font-semibold">Dry run</h2>
        <p class="text-xs text-slate-500">Nothing was written. Start import copies what is listed here.</p>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs">
            <thead class="text-slate-500">
              <tr>
                <th class="py-1 pr-2">Project</th>
                <th class="pr-2">Issues</th>
                <th class="pr-2">Epics</th>
                <th class="pr-2">Sub-tasks</th>
                <th class="pr-2">Statuses</th>
                <th class="pr-2">Sprints</th>
                <th>Files too big</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in imp.dryRun.projects" :key="p.jiraKey" class="border-t border-slate-100">
                <td class="py-1 pr-2 font-mono">{{ p.jiraKey }} to {{ p.targetKey }}</td>
                <td class="pr-2">{{ p.issues }}</td>
                <td class="pr-2">{{ p.epics }}</td>
                <td class="pr-2">{{ p.subtasks }}</td>
                <td class="pr-2">{{ p.statuses }}</td>
                <td class="pr-2">{{ p.sprints.active }} active, {{ p.sprints.future }} future, {{ p.sprints.closed }} closed</td>
                <td>{{ p.tooBigCount }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>People: {{ imp.dryRun.people.matched }} matched, {{ imp.dryRun.people.unmatched }} not matched.</p>
        <ul v-if="imp.dryRun.people.list.length" class="max-h-60 space-y-0.5 overflow-y-auto text-xs">
          <li v-for="(x, i) in imp.dryRun.people.list" :key="i" class="flex flex-wrap gap-x-2">
            <span :class="x.matched ? 'text-green-700' : 'text-red-700'">{{ x.matched ? 'Matched' : 'Not matched' }}</span>
            <span>{{ x.name }}</span><span v-if="x.email" class="text-slate-500">{{ x.email }}</span>
            <span v-if="x.how === 'name'" class="text-slate-500">(by name)</span>
          </li>
        </ul>
        <template v-if="imp.dryRun.totals.attachmentsTooBig">
          <p>Files over 10 MB (will be skipped):</p>
          <ul class="max-h-40 overflow-y-auto text-xs">
            <template v-for="p in imp.dryRun.projects" :key="p.jiraKey">
              <li v-for="f in p.attachmentsTooBig" :key="f.issue + f.filename" class="break-words">
                {{ f.issue }}: {{ f.filename }} ({{ size(f.size) }})
              </li>
            </template>
          </ul>
        </template>
      </div>

      <!-- Running and finished -->
      <div v-if="imp.mode === 'import' || active" class="card space-y-3 p-4 text-sm">
        <h2 class="font-semibold">{{ imp.status === 'done' ? 'Import finished' : imp.mode === 'dryrun' ? 'Dry run' : 'Import' }}</h2>
        <p v-if="active" class="text-slate-600">
          {{ STAGES[imp.stage] || imp.stage
          }}<template v-if="imp.status === 'waiting'">: Jira asked to slow down, continuing at {{ fmtDateTime(imp.retryAt) }}</template
          >. Keep this page open; if you close it, come back and press Continue.
        </p>
        <div v-if="active && totalIssues && imp.progress" class="h-2 overflow-hidden rounded-full bg-slate-100">
          <div
            class="h-full bg-accent"
            :style="{ width: `${Math.min(100, Math.round((imp.progress.issues / totalIssues) * 100))}%` }"
          ></div>
        </div>
        <dl v-if="progressRows.length" class="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs sm:grid-cols-4">
          <template v-for="[label, n] in progressRows" :key="label"
            ><dt class="text-slate-500">{{ label }}</dt>
            <dd>{{ n }}</dd></template
          >
        </dl>
        <p v-if="imp.error" class="break-words text-red-700">{{ imp.error }}</p>
        <button v-if="active && !driving" class="btn btn-primary" @click="drive">Continue</button>
        <template v-if="imp.report">
          <p>
            Projects created:
            <template v-for="(p, i) in imp.report.perProject" :key="p.targetKey"
              ><span v-if="i">, </span><RouterLink class="underline" :to="`/projects/${p.targetKey}`">{{ p.targetKey }}</RouterLink> ({{
                p.issues || 0
              }}
              issues)</template
            >.
          </p>
          <p v-if="imp.report.unmatched.length" class="text-xs text-slate-600">
            Not matched (their issues are unassigned, their comments say who wrote them):
            {{ imp.report.unmatched.map((x) => x.name).join(', ') }}
          </p>
          <p class="text-xs text-slate-500">The Jira token has been deleted.</p>
        </template>
      </div>

      <div v-if="imp.errors?.total" class="card">
        <h2 class="border-b border-slate-200 px-4 py-2 text-sm font-semibold">Problems ({{ imp.errors.total }})</h2>
        <ul class="max-h-72 divide-y divide-slate-100 overflow-y-auto text-xs">
          <li v-for="(e, i) in imp.errors.items" :key="i" class="break-words px-4 py-1.5">
            <span v-if="e.key" class="font-mono">{{ e.key }}: </span>{{ e.message }}
          </li>
        </ul>
      </div>
    </template>

    <div v-if="imports.length" class="card">
      <h2 class="border-b border-slate-200 px-4 py-2 text-sm font-semibold">Earlier imports</h2>
      <ul class="divide-y divide-slate-100 text-sm">
        <li v-for="x in imports" :key="x.id" class="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2">
          <button class="text-left underline" @click="open(x.id)">{{ fmtDateTime(x.createdAt) }}</button>
          <span class="text-slate-600">{{ x.site.replace('https://', '') }}</span>
          <span>{{ STATUS[x.status] || x.status }}</span>
          <span v-if="x.plan" class="text-xs text-slate-500">{{ x.plan.projects.map((p) => p.targetKey).join(', ') }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>
