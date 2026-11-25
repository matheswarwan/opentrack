<script setup>
import { ref, computed, onMounted, nextTick } from 'vue';
import { useRoute } from 'vue-router';
import { session } from '../api.js';
import { SECTIONS } from './help/sections.js';

const route = useRoute();
const role = computed(() => session.user?.role || 'member');
const audience = ref(role.value === 'admin' ? 'all' : role.value);

const AUDIENCES = [
  { id: 'all', label: 'Everything' },
  { id: 'member', label: 'Members' },
  { id: 'viewer', label: 'Viewers' },
  { id: 'guest', label: 'Guests' },
  { id: 'project-admin', label: 'Project admins' },
  { id: 'admin', label: 'Admins' },
];
function shown(s) {
  const a = audience.value;
  if (a === 'all') return true;
  if (s.for === 'everyone') return true;
  if (s.for === 'writers') return a !== 'viewer' && a !== 'guest';
  if (s.for === 'staff') return a !== 'guest'; // not for guests (clients)
  if (s.for === 'project-admins') return a === 'project-admin' || a === 'admin';
  if (s.for === 'admins') return a === 'admin';
  return true;
}
const visible = computed(() => SECTIONS.filter(shown));
const tag = (s) => ({ writers: 'Members and admins', 'project-admins': 'Project admins', admins: 'Admins' })[s.for];
const roleLabel = { admin: 'an admin', member: 'a member', viewer: 'a viewer', guest: 'a guest' };
onMounted(async () => {
  if (route.hash) {
    await nextTick();
    document.getElementById(route.hash.slice(1))?.scrollIntoView();
  }
});
</script>

<template>
  <div class="mx-auto flex max-w-6xl gap-8">
    <aside class="sticky top-16 hidden h-fit w-60 shrink-0 lg:block">
      <h2 class="mb-2 text-xs font-semibold uppercase text-slate-500">On this page</h2>
      <nav class="space-y-0.5 text-sm">
        <a v-for="s in visible" :key="s.id" :href="`#${s.id}`" class="block rounded px-2 py-1 text-slate-700 hover:bg-slate-100">{{
          s.title
        }}</a>
      </nav>
    </aside>
    <article class="min-w-0 flex-1 space-y-8 pb-20 text-sm leading-relaxed text-slate-800">
      <header>
        <h1 class="text-2xl font-semibold">Help</h1>
        <p class="mt-1 text-slate-600">You are signed in as {{ roleLabel[role] || role }}. Show help for:</p>
        <div class="mt-2 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Show help for">
          <button
            v-for="a in AUDIENCES"
            :key="a.id"
            role="radio"
            :aria-checked="audience === a.id"
            class="rounded-full border px-3 py-1 text-sm"
            :class="
              audience === a.id
                ? 'border-blue-700 bg-blue-50 font-medium text-blue-800'
                : 'border-slate-300 text-slate-600 hover:bg-slate-50'
            "
            @click="audience = a.id"
          >
            {{ a.label }}
          </button>
        </div>
      </header>

      <template v-for="s in visible" :key="s.id">
        <section :id="s.id" class="scroll-mt-16 space-y-2">
          <h2 class="flex items-center gap-2 text-lg font-semibold">
            {{ s.title }}<span v-if="tag(s)" class="chip bg-slate-100 text-slate-600">{{ tag(s) }}</span>
          </h2>

          <component :is="s.component" />
        </section>
      </template>
    </article>
  </div>
</template>
