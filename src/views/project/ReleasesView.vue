<script setup>
// Project > Releases: the project's versions with progress. Project admins create them here; each opens its release page.
import { ref, reactive, inject, computed } from 'vue';
import { useRouter } from 'vue-router';
import { get, post, toast } from '../../api.js';
import { fmtDate } from '../../meta.js';
import { RELEASE_STATUS } from '../../releases.js';
import ReleaseProgress from '../../components/ReleaseProgress.vue';
import { attempt } from '../../composables/useAction.js';
import { useLoad } from '../../composables/useLoad.js';
import LoadState from '../../components/LoadState.vue';

const project = inject('project');
const reloadProject = inject('reloadProject');
const router = useRouter();
const canAdmin = ref(false);
const show = ref('open'); // open (unreleased), released, archived, all
const creating = ref(false);
const form = reactive({ name: '', description: '', startDate: '', releaseDate: '' });
const busy = ref(false);
const base = () => `/api/projects/${project.value.key}/releases`;

const {
  data: releases,
  loading,
  error: loadError,
  reload: load,
} = useLoad(async () => {
  const r = await get(base());
  canAdmin.value = r.canAdmin;
  return r.releases;
});
const FILTERS = [
  { id: 'open', label: 'Unreleased' },
  { id: 'released', label: 'Released' },
  { id: 'archived', label: 'Archived' },
  { id: 'all', label: 'All' },
];
const listed = computed(() =>
  (releases.value || []).filter(
    (r) => show.value === 'all' || (show.value === 'open' ? r.status === 'unreleased' : r.status === show.value),
  ),
);
const count = (id) =>
  (releases.value || []).filter((r) => id === 'all' || (id === 'open' ? r.status === 'unreleased' : r.status === id)).length;

async function create() {
  busy.value = true;
  await attempt(async () => {
    const r = await post(base(), { ...form, startDate: form.startDate || null, releaseDate: form.releaseDate || null });
    toast(`Created ${r.release.name}`);
    Object.assign(form, { name: '', description: '', startDate: '', releaseDate: '' });
    creating.value = false;
    await load();
    reloadProject();
  });
  busy.value = false;
}
const open = (r) => router.push(`/projects/${project.value.key}/releases/${r.id}`);
</script>

<template>
  <div class="max-w-5xl space-y-3">
    <div class="flex flex-wrap items-center gap-2">
      <div class="flex flex-wrap gap-1" role="group" aria-label="Show releases">
        <button
          v-for="f in FILTERS"
          :key="f.id"
          class="rounded-full border px-3 py-1 text-sm"
          :class="show === f.id ? 'border-accent bg-accent text-white' : 'border-slate-200 bg-white text-slate-700 hover:border-slate-400'"
          :aria-pressed="show === f.id"
          @click="show = f.id"
        >
          {{ f.label }}<span v-if="releases" class="ml-1 text-xs opacity-70">{{ count(f.id) }}</span>
        </button>
      </div>
      <button v-if="canAdmin" class="btn btn-sm btn-primary ml-auto" @click="creating = !creating">New release</button>
    </div>

    <form v-if="creating" class="card grid gap-3 p-3 sm:grid-cols-2" @submit.prevent="create">
      <div>
        <label class="label" for="rl-name">Name</label
        ><input id="rl-name" v-model="form.name" class="input" maxlength="80" required placeholder="e.g. 2.4" />
      </div>
      <div>
        <label class="label" for="rl-desc">Description</label
        ><input id="rl-desc" v-model="form.description" class="input" maxlength="5000" />
      </div>
      <div>
        <label class="label" for="rl-start">Start date</label><input id="rl-start" v-model="form.startDate" type="date" class="input" />
      </div>
      <div>
        <label class="label" for="rl-date">Release date</label
        ><input id="rl-date" v-model="form.releaseDate" type="date" class="input" :min="form.startDate || undefined" />
      </div>
      <div class="flex gap-2 sm:col-span-2">
        <button class="btn btn-primary" :disabled="busy">Create release</button
        ><button type="button" class="btn" @click="creating = false">Cancel</button>
      </div>
    </form>

    <LoadState v-if="!releases" :loading="loading" :error="loadError" :rows="4" @retry="load" />
    <div v-else-if="!listed.length" class="card p-6 text-center text-sm text-slate-500">
      <template v-if="!releases.length"
        >No releases yet.<template v-if="canAdmin"> Create one, then add issues to it with the Fix versions field.</template
        ><template v-else> A project admin can create them.</template></template
      >
      <template v-else>Nothing here.</template>
    </div>
    <div v-else class="card divide-y divide-slate-100">
      <div
        v-for="r in listed"
        :key="r.id"
        class="grid cursor-pointer gap-2 px-3 py-3 hover:bg-slate-50 sm:grid-cols-[minmax(0,1fr)_14rem] sm:items-center"
        @click="open(r)"
      >
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <RouterLink :to="`/projects/${project.key}/releases/${r.id}`" class="font-semibold hover:underline" @click.stop>{{
              r.name
            }}</RouterLink>
            <span class="chip" :class="RELEASE_STATUS[r.status].cls">{{ RELEASE_STATUS[r.status].label }}</span>
            <span v-if="r.overdue" class="chip bg-red-100 text-red-800">Overdue</span>
          </div>
          <p class="mt-0.5 text-xs text-slate-500">
            <template v-if="r.startDate">{{ fmtDate(r.startDate) }} to </template>
            <template v-if="r.status === 'released'">released {{ fmtDate(r.releaseDate || r.releasedAt) }}</template>
            <template v-else-if="r.releaseDate">{{ r.startDate ? '' : 'release ' }}{{ fmtDate(r.releaseDate) }}</template>
            <template v-else>No release date</template>
          </p>
          <p v-if="r.description" class="truncate text-xs text-slate-500">{{ r.description }}</p>
        </div>
        <ReleaseProgress :progress="r.progress" />
      </div>
    </div>
  </div>
</template>
