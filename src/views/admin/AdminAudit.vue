<script setup>
// Audit log with filters like AI audit (MCP): source, person, action,
// text, dates; paging and CSV. Filters live in the URL.
import { ref, reactive, watch, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { get, qs, users as loadUsers } from '../../api.js';
import { fmtDateTime } from '../../meta.js';
import { attempt } from '../../composables/useAction.js';
import { useLoad } from '../../composables/useLoad.js';
import LoadState from '../../components/LoadState.vue';

const route = useRoute();
const router = useRouter();
const f = reactive({ source: '', actor: '', action: '', q: '', from: '', to: '' });
const entries = ref([]);
const more = ref(false);
const nextBefore = ref(null);
const people = ref([]);
loadUsers()
  .then((u) => (people.value = u))
  .catch(() => {});
const query = (extra = {}) => qs({ limit: 200, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), ...extra });
// manual: the route watch below reads the filters from the URL first
const {
  loading,
  error: loadError,
  reload: load,
} = useLoad(
  async () => {
    const r = await get(`/api/admin/audit?${query()}`);
    entries.value = r.entries;
    more.value = r.more;
    nextBefore.value = r.nextBefore;
    return true;
  },
  null,
  { manual: true, eachTime: true },
);
const loadMore = () =>
  attempt(async () => {
    const r = await get(`/api/admin/audit?${query({ before: nextBefore.value })}`);
    entries.value.push(...r.entries);
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
const csvHref = computed(() => `/api/admin/audit.csv?${query({ limit: 5000 })}`);
const describe = (d) =>
  d
    ? Object.entries(d)
        .map(([k, v]) => `${k}: ${typeof v === 'object' && v ? `${v.from ?? ''} → ${v.to ?? ''}` : v}`)
        .join(', ')
    : '';
</script>
<template>
  <p class="mb-3 max-w-3xl text-sm text-slate-600">
    Admin and account changes, plus AI assistant (MCP) calls that changed something or were refused. Every AI call, reads too, is in
    <RouterLink to="/admin/mcp" class="link">AI audit (MCP)</RouterLink>.
  </p>
  <div class="card mb-3 flex flex-wrap items-end gap-2 p-3" role="search" aria-label="Filter the audit log">
    <label class="w-40"
      ><span class="label">Kind</span
      ><select v-model="f.source" class="input py-1" @change="apply">
        <option value="">Everything</option>
        <option value="admin">Admin and account changes</option>
        <option value="ai">AI assistant</option>
      </select></label
    >
    <label class="w-44"
      ><span class="label">Person</span
      ><select v-model="f.actor" class="input py-1" @change="apply">
        <option value="">Everyone</option>
        <option v-for="u in people" :key="u.id" :value="u.id">{{ u.name }}</option>
      </select></label
    >
    <label class="w-40"
      ><span class="label">Action</span
      ><input v-model="f.action" class="input py-1" placeholder="user., settings, ai." @keydown.enter="apply" @blur="apply"
    /></label>
    <label class="w-48"
      ><span class="label">Text</span
      ><input v-model="f.q" class="input py-1" placeholder="Name, email, issue key" @keydown.enter="apply" @blur="apply"
    /></label>
    <label><span class="label">From</span><input v-model="f.from" type="date" class="input py-1" @change="apply" /></label>
    <label><span class="label">To</span><input v-model="f.to" type="date" class="input py-1" @change="apply" /></label>
    <button v-if="filtered" class="btn btn-sm btn-ghost" @click="clear">Clear</button>
    <a class="btn btn-sm ml-auto" :href="csvHref">Export CSV</a>
  </div>
  <div class="card overflow-x-auto">
    <div v-if="loading || loadError" class="p-4"><LoadState :loading="loading" :error="loadError" :rows="6" @retry="load" /></div>
    <table v-else class="w-full text-sm">
      <thead class="bg-slate-50 text-left text-xs uppercase text-slate-500">
        <tr>
          <th class="px-3 py-2">When</th>
          <th class="px-3 py-2">Who</th>
          <th class="px-3 py-2">Action</th>
          <th class="px-3 py-2">Target</th>
          <th class="px-3 py-2">Details</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="e in entries" :key="e.id" class="border-t border-slate-100">
          <td class="whitespace-nowrap px-3 py-1.5 text-slate-600">{{ fmtDateTime(e.createdAt) }}</td>
          <td class="px-3 py-1.5">{{ e.actorName || 'System' }}</td>
          <td class="px-3 py-1.5 font-mono text-xs">
            {{ e.action }}
            <span
              v-if="e.source === 'mcp'"
              class="chip bg-violet-100 font-sans text-violet-900"
              title="An AI assistant (MCP) acting for this person"
              >AI assistant</span
            >
          </td>
          <td class="px-3 py-1.5">{{ e.targetName || '' }}</td>
          <td class="px-3 py-1.5 text-xs text-slate-600">{{ describe(e.details) }}</td>
        </tr>
        <tr v-if="!entries.length">
          <td colspan="5" class="px-3 py-8 text-center text-slate-500">
            {{ filtered ? 'Nothing matches these filters.' : 'Nothing recorded yet.' }}
          </td>
        </tr>
      </tbody>
    </table>
    <div v-if="more && !loading" class="border-t border-slate-100 p-3 text-center">
      <button class="btn btn-sm" @click="loadMore">Load more</button>
    </div>
  </div>
</template>
