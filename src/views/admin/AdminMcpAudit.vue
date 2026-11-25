<script setup>
// MCP audit log: every call an AI assistant made through the MCP server, with what it touched.
import { ref, reactive, watch, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { get, patch, qs, toast, users as loadUsers } from '../../api.js';
import { fmtDateTime } from '../../meta.js';
import { attempt } from '../../composables/useAction.js';
import { useLoad } from '../../composables/useLoad.js';
import LoadState from '../../components/LoadState.vue';

const route = useRoute();
const router = useRouter();
const TOOLS = [
  'list_projects',
  'my_work',
  'search_issues',
  'get_issue',
  'create_issue',
  'update_issue',
  'add_comment',
  'log_work',
  'add_link',
  'list_sprints',
  'list_users',
  'list_releases',
  'list_raid',
  'project_report',
  'run_report',
];
const f = reactive({ user: '', tool: '', result: '', write: '', project: '', issue: '', from: '', to: '' });
const calls = ref([]);
const more = ref(false);
const nextBefore = ref(null);
const people = ref([]);
const retention = ref(90);
const open = ref(null);
loadUsers()
  .then((u) => (people.value = u))
  .catch(() => {});
get('/api/admin/settings')
  .then((r) => (retention.value = r.settings.mcpLogDays || 90))
  .catch(() => {});

const query = (extra = {}) => qs({ all: 1, limit: 100, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), ...extra });
// manual: the route watch below reads the filters from the URL first
const {
  loading,
  error: loadError,
  reload: load,
} = useLoad(
  async () => {
    const r = await get(`/api/mcp/activity?${query()}`);
    calls.value = r.calls;
    more.value = r.more;
    nextBefore.value = r.nextBefore;
    return true;
  },
  null,
  { manual: true, eachTime: true },
);
const loadMore = () =>
  attempt(async () => {
    const r = await get(`/api/mcp/activity?${query({ before: nextBefore.value })}`);
    calls.value.push(...r.calls);
    more.value = r.more;
    nextBefore.value = r.nextBefore;
  });
watch(
  () => route.query,
  () => {
    for (const k of Object.keys(f)) f[k] = String(route.query[k] || '');
    load();
  },
  { immediate: true },
);
const apply = () => router.replace({ query: Object.fromEntries(Object.entries(f).filter(([, v]) => v)) });
const clear = () => {
  for (const k of Object.keys(f)) f[k] = '';
  apply();
};
const filtered = computed(() => Object.values(f).some(Boolean));
const csvHref = computed(() => `/api/mcp/activity.csv?${query({ limit: 5000 })}`);
const resultCls = { ok: 'bg-green-100 text-green-900', error: 'bg-red-100 text-red-900', rejected: 'bg-amber-100 text-amber-900' };
const resultLabel = { ok: 'OK', error: 'Error', rejected: 'Refused' };
const argText = (a) =>
  a
    ? Object.entries(a)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .join(' · ')
    : '';
async function saveRetention() {
  await attempt(async () => {
    await patch('/api/admin/settings', { mcpLogDays: Math.min(730, Math.max(7, Number(retention.value) || 90)) });
    toast('Saved');
  });
}
</script>

<template>
  <p class="mb-3 max-w-3xl text-sm text-slate-600">
    Every call an AI assistant (Claude, ChatGPT, Copilot and others) made through the MCP server: who, which app or token, which tool, what
    it touched and the result. Long text such as descriptions and comments is recorded only as a length; tokens are never stored, only their
    first characters. Changes made this way are also marked "via AI assistant" in issue history.
  </p>
  <div class="card mb-3 flex flex-wrap items-end gap-2 p-3">
    <label class="w-44"
      ><span class="label">Person</span
      ><select v-model="f.user" class="input py-1" @change="apply">
        <option value="">Everyone</option>
        <option v-for="u in people" :key="u.id" :value="u.id">{{ u.name }}</option>
      </select></label
    >
    <label class="w-40"
      ><span class="label">Tool</span
      ><select v-model="f.tool" class="input py-1" @change="apply">
        <option value="">Any tool</option>
        <option v-for="t in TOOLS" :key="t" :value="t">{{ t }}</option>
      </select></label
    >
    <label class="w-32"
      ><span class="label">Result</span
      ><select v-model="f.result" class="input py-1" @change="apply">
        <option value="">Any</option>
        <option value="ok">OK</option>
        <option value="error">Error</option>
        <option value="rejected">Refused credential</option>
      </select></label
    >
    <label class="flex items-center gap-1.5 pb-1.5 text-sm"
      ><input v-model="f.write" type="checkbox" true-value="1" false-value="" @change="apply" /> Only calls that change data</label
    >
    <label class="w-24"
      ><span class="label">Project</span
      ><input v-model="f.project" class="input py-1 uppercase" placeholder="KEY" @keydown.enter="apply" @blur="apply"
    /></label>
    <label class="w-28"
      ><span class="label">Issue</span
      ><input v-model="f.issue" class="input py-1 uppercase" placeholder="KEY-12" @keydown.enter="apply" @blur="apply"
    /></label>
    <label><span class="label">From</span><input v-model="f.from" type="date" class="input py-1" @change="apply" /></label>
    <label><span class="label">To</span><input v-model="f.to" type="date" class="input py-1" @change="apply" /></label>
    <button v-if="filtered" class="btn btn-sm btn-ghost" @click="clear">Clear</button>
    <a class="btn btn-sm ml-auto" :href="csvHref">Export CSV</a>
  </div>

  <div class="card overflow-x-auto">
    <div v-if="loading || loadError" class="p-4"><LoadState :loading="loading" :error="loadError" :rows="6" @retry="load" /></div>
    <table v-else class="w-full min-w-[56rem] text-sm">
      <thead class="bg-slate-50 text-left text-xs uppercase text-slate-500">
        <tr>
          <th class="px-3 py-2">When</th>
          <th class="px-3 py-2">Who</th>
          <th class="px-3 py-2">App or token</th>
          <th class="px-3 py-2">Tool</th>
          <th class="px-3 py-2">Touched</th>
          <th class="px-3 py-2">Result</th>
          <th class="px-3 py-2 text-right">Time</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="r in calls" :key="r.id">
          <tr class="cursor-pointer border-t border-slate-100 hover:bg-slate-50" @click="open = open === r.id ? null : r.id">
            <td class="whitespace-nowrap px-3 py-1.5 text-slate-600">
              <button
                type="button"
                class="hover:underline"
                :aria-expanded="open === r.id"
                :aria-label="`Details of the ${r.tool || 'refused'} call at ${fmtDateTime(r.createdAt)}`"
                @click.stop="open = open === r.id ? null : r.id"
              >
                {{ fmtDateTime(r.createdAt) }}
              </button>
            </td>
            <td class="px-3 py-1.5">{{ r.user?.name || 'Unknown' }}</td>
            <td class="px-3 py-1.5 text-slate-600">
              {{ r.clientName || '' }} <code v-if="r.tokenPrefix" class="text-xs text-slate-500">{{ r.tokenPrefix }}…</code>
            </td>
            <td class="px-3 py-1.5">
              <code class="text-xs">{{ r.tool || '(refused credential)' }}</code>
              <span v-if="r.write" class="chip bg-violet-100 text-violet-900">changes data</span>
            </td>
            <td class="px-3 py-1.5">
              <RouterLink v-for="k in r.issueKeys" :key="k" :to="`/browse/${k}`" class="link mr-1.5" @click.stop>{{ k }}</RouterLink>
              <span v-if="!r.issueKeys.length && r.projectKey" class="text-slate-600">{{ r.projectKey }}</span>
            </td>
            <td class="px-3 py-1.5">
              <span class="chip" :class="resultCls[r.result]">{{ resultLabel[r.result] }}</span>
            </td>
            <td class="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-600">
              {{ r.durationMs !== null && r.durationMs !== undefined ? `${r.durationMs} ms` : '' }}
            </td>
          </tr>
          <tr v-if="open === r.id" class="bg-slate-50">
            <td colspan="7" class="px-3 py-2 text-xs text-slate-700">
              <div v-if="r.args"><strong>Arguments:</strong> {{ argText(r.args) || 'none' }}</div>
              <div v-if="r.error" class="mt-1 text-red-800"><strong>Error:</strong> {{ r.error }}</div>
              <div v-if="r.user?.email" class="mt-1"><strong>Email:</strong> {{ r.user.email }}</div>
            </td>
          </tr>
        </template>
        <tr v-if="!calls.length">
          <td colspan="7" class="px-3 py-10 text-center text-slate-500">
            {{ filtered ? 'No calls match these filters.' : 'No AI assistant calls yet.' }}
          </td>
        </tr>
      </tbody>
    </table>
    <div v-if="more && !loading" class="p-3 text-center"><button class="btn btn-sm" @click="loadMore">Load more</button></div>
  </div>

  <form class="card mt-3 flex flex-wrap items-end gap-2 p-3 text-sm" @submit.prevent="saveRetention">
    <label class="w-40"
      ><span class="label">Keep entries for (days)</span
      ><input v-model.number="retention" type="number" min="7" max="730" class="input py-1"
    /></label>
    <button class="btn btn-sm">Save</button>
    <span class="text-xs text-slate-500">Older entries are removed automatically (7 to 730 days).</span>
  </form>
</template>
