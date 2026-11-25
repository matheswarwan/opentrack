<script setup>
import { ref, reactive, inject, watch, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { get, qs, users as loadUsers } from '../../api.js';
import { ui } from '../../ui.js';
import { ago, fmtDateTime, activityVerb } from '../../meta.js';
import { today, addDays } from '../../dates.js';
import { plain } from '../../markdown.js';
import Avatar from '../../components/Avatar.vue';
import LoadState from '../../components/LoadState.vue';
import { attempt } from '../../composables/useAction.js';
import { useLoad } from '../../composables/useLoad.js';

const project = inject('project');
const route = useRoute();
const router = useRouter();
const TYPES = [
  { id: 'all', label: 'Everything' },
  { id: 'comment', label: 'Comments' },
  { id: 'change', label: 'All changes' },
  { id: 'status', label: 'Status changes' },
  { id: 'assignee', label: 'Assignments' },
  { id: 'created', label: 'New issues' },
  { id: 'priority', label: 'Priority changes' },
  { id: 'due_date', label: 'Due date changes' },
  { id: 'sprint', label: 'Sprint changes' },
  { id: 'description', label: 'Description edits' },
];
const f = reactive({ type: 'all', actor: '', from: '', to: '' });
const items = ref([]);
const more = ref(false);
const nextBefore = ref(null);
const loadingMore = ref(false);
const people = ref([]);
loadUsers()
  .then((u) => (people.value = u))
  .catch(() => {});

function fromRoute() {
  f.type = String(route.query.type || 'all');
  f.actor = String(route.query.actor || '');
  f.from = String(route.query.from || '');
  f.to = String(route.query.to || '');
}
const query = (extra = {}) =>
  qs({ project: project.value.key, limit: 100, type: f.type === 'all' ? '' : f.type, actor: f.actor, from: f.from, to: f.to, ...extra });
// manual: the route watch below reads the filters from the URL first
const {
  loading,
  error: loadError,
  reload: load,
} = useLoad(
  async () => {
    const r = await get(`/api/activity?${query()}`);
    items.value = r.items;
    more.value = r.more;
    nextBefore.value = r.nextBefore;
    return true;
  },
  null,
  { manual: true, eachTime: true },
);
async function loadMore() {
  loadingMore.value = true;
  await attempt(async () => {
    const r = await get(`/api/activity?${query({ before: nextBefore.value })}`);
    const seen = new Set(items.value.map((i) => i.id));
    items.value.push(...r.items.filter((i) => !seen.has(i.id)));
    more.value = r.more;
    nextBefore.value = r.nextBefore;
  });
  loadingMore.value = false;
}
watch(
  () => [route.query, ui.changes],
  () => {
    fromRoute();
    load();
  },
  { immediate: true, deep: true },
);
function apply() {
  router.replace({
    query: { type: f.type === 'all' ? undefined : f.type, actor: f.actor || undefined, from: f.from || undefined, to: f.to || undefined },
  });
}
function setRange(days) {
  f.from = days === null ? '' : addDays(today(), -days);
  f.to = '';
  apply();
}
const filtered = computed(() => f.type !== 'all' || f.actor || f.from || f.to);
function clear() {
  Object.assign(f, { type: 'all', actor: '', from: '', to: '' });
  apply();
}
</script>
<template>
  <div class="mx-auto max-w-3xl space-y-3">
    <div class="card flex flex-wrap items-end gap-2 p-3">
      <label class="w-44"
        ><span class="label">Show</span>
        <select v-model="f.type" class="input py-1" @change="apply">
          <option v-for="t in TYPES" :key="t.id" :value="t.id">{{ t.label }}</option>
        </select>
      </label>
      <label class="w-44"
        ><span class="label">By</span>
        <select v-model="f.actor" class="input py-1" @change="apply">
          <option value="">Anyone</option>
          <option v-for="u in people" :key="u.id" :value="u.id">{{ u.name }}</option>
        </select>
      </label>
      <label
        ><span class="label">From</span><input v-model="f.from" type="date" class="input py-1" :max="f.to || undefined" @change="apply"
      /></label>
      <label
        ><span class="label">To</span><input v-model="f.to" type="date" class="input py-1" :min="f.from || undefined" @change="apply"
      /></label>
      <div class="flex flex-wrap gap-1" role="group" aria-label="Quick date ranges">
        <button type="button" class="btn btn-sm" @click="setRange(1)">24 hours</button>
        <button type="button" class="btn btn-sm" @click="setRange(7)">7 days</button>
        <button type="button" class="btn btn-sm" @click="setRange(30)">30 days</button>
      </div>
      <button v-if="filtered" type="button" class="btn btn-sm btn-ghost" @click="clear">Clear</button>
    </div>
    <div class="card">
      <div v-if="loading || loadError" class="p-4"><LoadState :loading="loading" :error="loadError" :rows="6" @retry="load" /></div>
      <p v-else-if="!items.length" class="px-3 py-10 text-center text-sm text-slate-500">
        {{ filtered ? 'Nothing matches these filters.' : 'No activity yet.' }}
      </p>
      <div v-for="a in loading || loadError ? [] : items" :key="a.id" class="flex gap-3 border-b border-slate-100 px-4 py-2.5 text-sm">
        <Avatar :user="a.actor" :size="26" />
        <div class="min-w-0 flex-1">
          <div>
            <strong class="font-medium">{{ a.actor.name || 'Former user' }}</strong> {{ activityVerb(a)
            }}{{ a.field === 'status' ? ' on' : '' }} <RouterLink :to="`/browse/${a.issue.key}`" class="link">{{ a.issue.key }}</RouterLink>
            <span class="text-slate-600">{{ a.issue.title }}</span>
            <span v-if="a.viaAi" class="chip bg-violet-100 text-violet-900" title="Made by an AI assistant (MCP) acting for this person"
              >via AI assistant</span
            >
          </div>
          <div v-if="a.kind === 'comment'" class="mt-0.5 line-clamp-2 text-slate-600">
            <span v-if="a.internal" class="chip mr-1 bg-amber-100 text-amber-900">Internal</span>{{ plain(a.body) }}
          </div>
          <div v-else-if="!['description', 'created', 'restored'].includes(a.field)" class="mt-0.5 text-slate-600">
            {{ a.from ?? 'None' }} → {{ a.to ?? 'None' }}
          </div>
          <div class="text-xs text-slate-500" :title="fmtDateTime(a.createdAt)">{{ ago(a.createdAt) }}</div>
        </div>
      </div>
      <div v-if="more && !loading && !loadError" class="p-3 text-center">
        <button class="btn btn-sm" :disabled="loadingMore" @click="loadMore">{{ loadingMore ? 'Loading…' : 'Load more' }}</button>
      </div>
    </div>
  </div>
</template>
