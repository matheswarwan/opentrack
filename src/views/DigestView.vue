<script setup>
// Weekly digest for the signed-in person: the same content the weekly email and Slack message carry.
import { get } from '../api.js';
import LoadState from '../components/LoadState.vue';
import { counted as plural } from '../plural.js';
import { useLoad } from '../composables/useLoad.js';

const { data: d, loading, error: loadError, reload: load } = useLoad(() => get('/api/digest'));
const openLink = '/issues?assignee=me&category=todo,in_progress';
</script>
<template>
  <div class="mx-auto max-w-3xl space-y-4">
    <div>
      <h1 class="text-xl font-semibold">Your weekly digest</h1>
      <p class="text-sm text-slate-600">
        What is on your plate, and what changed in the last 7 days.
        <RouterLink to="/profile" class="link">Choose how it reaches you</RouterLink>.
      </p>
    </div>
    <LoadState v-if="!d" :loading="loading" :error="loadError" card :rows="4" @retry="load" />
    <template v-else>
      <section class="card p-4">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h2 class="text-sm font-semibold">Open issues assigned to you: {{ d.open.total }}</h2>
          <RouterLink :to="openLink" class="link text-sm">Open the list</RouterLink>
        </div>
        <div v-if="d.open.byStatus.length" class="mt-2 flex flex-wrap gap-2">
          <span v-for="s in d.open.byStatus" :key="s.status" class="rounded-full border border-slate-200 px-2.5 py-0.5 text-xs"
            >{{ s.status }}: {{ s.count }}</span
          >
        </div>
        <p v-else class="mt-1 text-sm text-slate-500">Nothing assigned to you.</p>
      </section>

      <section v-if="d.overdue.length" class="card">
        <h2 class="border-b border-slate-200 px-4 py-2 text-sm font-semibold text-red-700">Overdue ({{ d.overdue.length }})</h2>
        <RouterLink
          v-for="i in d.overdue"
          :key="i.key"
          :to="`/browse/${i.key}`"
          class="flex gap-2 border-b border-slate-100 px-4 py-2 text-sm hover:bg-slate-50"
        >
          <span class="shrink-0 font-medium">{{ i.key }}</span><span class="min-w-0 flex-1 truncate">{{ i.title }}</span
          ><span class="shrink-0 text-xs text-red-700">{{ i.due }}</span>
        </RouterLink>
      </section>

      <section class="card">
        <h2 class="border-b border-slate-200 px-4 py-2 text-sm font-semibold">Due in the next 7 days ({{ d.dueThisWeek.length }})</h2>
        <p v-if="!d.dueThisWeek.length" class="px-4 py-3 text-sm text-slate-500">Nothing due this week.</p>
        <RouterLink
          v-for="i in d.dueThisWeek"
          :key="i.key"
          :to="`/browse/${i.key}`"
          class="flex gap-2 border-b border-slate-100 px-4 py-2 text-sm hover:bg-slate-50"
        >
          <span class="shrink-0 font-medium">{{ i.key }}</span><span class="min-w-0 flex-1 truncate">{{ i.title }}</span
          ><span class="shrink-0 text-xs text-slate-500">{{ i.due }}</span>
        </RouterLink>
      </section>

      <section class="card">
        <h2 class="border-b border-slate-200 px-4 py-2 text-sm font-semibold">
          Issues you watch that others changed ({{ d.watched.length }})
        </h2>
        <p v-if="!d.watched.length" class="px-4 py-3 text-sm text-slate-500">No changes by others this week.</p>
        <RouterLink
          v-for="w in d.watched"
          :key="w.key"
          :to="`/browse/${w.key}`"
          class="flex flex-wrap gap-x-2 border-b border-slate-100 px-4 py-2 text-sm hover:bg-slate-50"
        >
          <span class="shrink-0 font-medium">{{ w.key }}</span><span class="min-w-0 flex-1 truncate">{{ w.title }}</span>
          <span class="shrink-0 text-xs text-slate-500">{{
            [w.changes ? plural(w.changes, 'change') : '', w.comments ? plural(w.comments, 'comment') : ''].filter(Boolean).join(', ')
          }}</span>
        </RouterLink>
      </section>

      <section class="card">
        <h2 class="border-b border-slate-200 px-4 py-2 text-sm font-semibold">Mentions ({{ d.mentions.length }})</h2>
        <p v-if="!d.mentions.length" class="px-4 py-3 text-sm text-slate-500">Nobody mentioned you this week.</p>
        <RouterLink
          v-for="(m, i) in d.mentions"
          :key="i"
          :to="`/browse/${m.key}`"
          class="flex gap-2 border-b border-slate-100 px-4 py-2 text-sm hover:bg-slate-50"
        >
          <span class="shrink-0 font-medium">{{ m.key }}</span><span class="min-w-0 flex-1 truncate">{{ m.title }}</span
          ><span v-if="m.by" class="shrink-0 text-xs text-slate-500">by {{ m.by }}</span>
        </RouterLink>
      </section>
    </template>
  </div>
</template>
