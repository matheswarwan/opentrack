<script setup>
import { ref, reactive, watch, computed } from 'vue';
import { useRouter } from 'vue-router';
import { get, session, qs, users as loadUsers } from '../api.js';
import { ui } from '../ui.js';
import { projectList } from '../projects.js';
import { ago, activityVerb } from '../meta.js';
import { plain } from '../markdown.js';
import IssueRow from '../components/IssueRow.vue';
import Avatar from '../components/Avatar.vue';
import LoadState from '../components/LoadState.vue';
import { attempt } from '../composables/useAction.js';
import { useLoad } from '../composables/useLoad.js';
import { openCreate } from '../ui.js';

const router = useRouter();
const activity = ref([]);
const tab = ref('assigned');
// Recent activity filters: project, kind, person; kept per browser
const ACT_KEY = 'it_home_activity';
const act = reactive(
  (() => {
    try {
      return { project: '', type: 'all', actor: '', ...JSON.parse(localStorage.getItem(ACT_KEY) || '{}') };
    } catch {
      return { project: '', type: 'all', actor: '' };
    }
  })(),
);
const actMore = ref(false);
const actNext = ref(null);
const projects = ref([]);
const people = ref([]);
const actFiltered = computed(() => Boolean(act.project || act.actor || act.type !== 'all'));
const actQuery = (extra = {}) =>
  qs({ limit: 25, ...Object.fromEntries(Object.entries(act).filter(([k, v]) => v && !(k === 'type' && v === 'all'))), ...extra });
async function loadActivity() {
  const r = await get(`/api/activity?${actQuery()}`);
  activity.value = r.items;
  actMore.value = r.more;
  actNext.value = r.nextBefore;
}
const moreActivity = () =>
  attempt(async () => {
    const r = await get(`/api/activity?${actQuery({ before: actNext.value })}`);
    activity.value.push(...r.items);
    actMore.value = r.more;
    actNext.value = r.nextBefore;
  });
watch(act, () => {
  try {
    localStorage.setItem(ACT_KEY, JSON.stringify(act));
  } catch {
    /* storage blocked */
  }
  attempt(loadActivity);
});
const clearAct = () => Object.assign(act, { project: '', type: 'all', actor: '' });
const {
  data,
  loading,
  error: loadError,
  reload: load,
} = useLoad(
  async () => (await Promise.all([get('/api/dashboard'), loadActivity()]))[0],
  () => ui.changes,
);
projectList()
  .then((list) => (projects.value = list))
  .catch(() => {});
loadUsers()
  .then((u) => (people.value = u))
  .catch(() => {});
const open = (i) => router.push(`/browse/${i.key}`);
const tabs = [
  { id: 'assigned', label: 'Assigned to me' },
  { id: 'reported', label: 'Reported by me' },
  { id: 'watching', label: 'Watching' },
];
</script>
<template>
  <div class="grid gap-4 lg:grid-cols-3">
    <section class="lg:col-span-2 space-y-4">
      <h1 class="text-xl font-semibold">Hi {{ session.user.name.split(' ')[0] }}</h1>
      <LoadState v-if="!data" :loading="loading" :error="loadError" card :rows="4" @retry="load" />
      <div
        v-if="data && !data.assigned.length && !data.reported.length && !data.watching.length"
        class="rounded-[15px] bg-black p-5 text-white"
      >
        <div class="text-xs font-bold uppercase tracking-wider text-accent">Welcome</div>
        <h2 class="mt-1 text-xl">Nothing on your plate yet</h2>
        <p class="mt-1 text-sm text-white/75">
          Open a project to see its board, or create your first issue. Everything assigned to you will show up here.
        </p>
        <div class="mt-3 flex flex-wrap gap-2">
          <button class="btn btn-primary" @click="openCreate()">Create an issue</button>
          <RouterLink to="/projects" class="btn border-white bg-black text-white hover:bg-white/10">Browse projects</RouterLink>
          <RouterLink to="/help" class="btn border-white bg-black text-white hover:bg-white/10">How it works</RouterLink>
        </div>
      </div>
      <div v-if="data" class="grid grid-cols-3 gap-3">
        <div class="card p-3">
          <div class="text-2xl font-semibold">{{ data.counts.todo || 0 }}</div>
          <div class="text-xs text-slate-500">To do, assigned to you</div>
        </div>
        <div class="card p-3">
          <div class="text-2xl font-semibold text-blue-700">{{ data.counts.in_progress || 0 }}</div>
          <div class="text-xs text-slate-500">In progress</div>
        </div>
        <div class="card p-3">
          <div class="text-2xl font-semibold text-green-700">{{ data.counts.done || 0 }}</div>
          <div class="text-xs text-slate-500">Done</div>
        </div>
      </div>
      <div v-if="data?.dueSoon.length" class="card">
        <h2 class="border-b border-slate-200 px-3 py-2 text-sm font-semibold">Due in the next 7 days or overdue</h2>
        <IssueRow v-for="i in data.dueSoon" :key="i.id" :issue="i" @open="open" />
      </div>
      <div class="card">
        <div class="flex gap-1 border-b border-slate-200 px-2 pt-2">
          <button
            v-for="t in tabs"
            :key="t.id"
            class="rounded-t px-3 py-1.5 text-sm"
            :class="tab === t.id ? 'border-b-2 border-blue-700 font-semibold text-blue-800' : 'text-slate-600'"
            @click="tab = t.id"
          >
            {{ t.label }}
          </button>
        </div>
        <template v-if="data">
          <IssueRow v-for="i in data[tab]" :key="i.id" :issue="i" @open="open" />
          <p v-if="!data[tab].length" class="px-3 py-8 text-center text-sm text-slate-500">Nothing here.</p>
        </template>
      </div>
    </section>
    <aside class="card h-fit">
      <h2 class="border-b border-slate-200 px-3 py-2 text-sm font-semibold">Recent activity</h2>
      <div class="flex flex-wrap gap-1.5 border-b border-slate-200 px-3 py-2" role="group" aria-label="Filter recent activity">
        <select v-model="act.project" class="input w-auto max-w-[9rem] py-0.5 text-xs" aria-label="Project">
          <option value="">All projects</option>
          <option v-for="p in projects" :key="p.key" :value="p.key">{{ p.name }}</option>
        </select>
        <select v-model="act.type" class="input w-auto py-0.5 text-xs" aria-label="Kind of activity">
          <option value="all">Everything</option>
          <option value="comment">Comments</option>
          <option value="change">Changes</option>
          <option value="status">Status changes</option>
          <option value="assignee">Assignee changes</option>
          <option value="created">Created</option>
        </select>
        <select v-model="act.actor" class="input w-auto max-w-[9rem] py-0.5 text-xs" aria-label="Person">
          <option value="">Everyone</option>
          <option v-if="session.user" :value="session.user.id">Me</option>
          <option v-for="u in people.filter((x) => x.id !== session.user?.id)" :key="u.id" :value="u.id">{{ u.name }}</option>
        </select>
        <button v-if="actFiltered" type="button" class="btn btn-sm btn-ghost px-2 py-0.5 text-xs" @click="clearAct">Clear</button>
      </div>
      <p v-if="!activity.length" class="px-3 py-6 text-center text-sm text-slate-500">
        {{ actFiltered ? 'Nothing matches these filters.' : 'No activity yet.' }}
      </p>
      <div v-for="a in activity" :key="a.id" class="flex gap-2 border-b border-slate-100 px-3 py-2 text-sm">
        <Avatar :user="a.actor" :size="22" />
        <div class="min-w-0 flex-1">
          <div>
            <strong class="font-medium">{{ a.actor.name || 'Former user' }}</strong> {{ activityVerb(a) }}
            <template v-if="a.kind === 'change' && a.field === 'status'">
              to <strong>{{ a.to }}</strong> on</template
            >
            <RouterLink :to="`/browse/${a.issue.key}`" class="link">{{ a.issue.key }}</RouterLink>
            <span v-if="a.viaAi" class="chip bg-violet-100 text-violet-900" title="Made by an AI assistant (MCP) acting for this person"
              >via AI assistant</span
            >
          </div>
          <div v-if="a.kind === 'comment'" class="truncate text-slate-500">{{ plain(a.body) }}</div>
          <div class="text-xs text-slate-400">{{ ago(a.createdAt) }}</div>
        </div>
      </div>
      <div v-if="actMore" class="p-2 text-center"><button type="button" class="btn btn-sm" @click="moreActivity">Load more</button></div>
    </aside>
  </div>
</template>
