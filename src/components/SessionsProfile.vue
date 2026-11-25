<script setup>
// Profile card: where the person is signed in. Sign out one session, or everywhere else.
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { get, post, del, toast, session } from '../api.js';
import { ago } from '../meta.js';
import { attempt } from '../composables/useAction.js';
import { plural } from '../plural.js';

const router = useRouter();
const list = ref(null);
const idle = ref(0);
const busy = ref(false);
async function load() {
  try {
    const r = await get('/api/me/sessions');
    list.value = r.sessions;
    idle.value = r.idleTimeoutMinutes || 0;
  } catch {
    list.value = null;
  }
}
onMounted(load);
const others = computed(() => (list.value || []).filter((s) => !s.current).length);
const idleText = computed(() => {
  const m = idle.value;
  if (!m) return '';
  if (m % 1440 === 0) return `${m / 1440} ${m === 1440 ? 'day' : 'days'}`;
  if (m % 60 === 0) return `${m / 60} ${m === 60 ? 'hour' : 'hours'}`;
  return `${m} minutes`;
});
const when = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

async function signOut(s) {
  if (s.current && !confirm('Sign out of this browser?')) return;
  busy.value = true;
  try {
    await del(`/api/me/sessions/${s.id}`);
    if (s.current) {
      session.user = null;
      router.push({ name: 'login' });
      return;
    }
    toast(`Signed out: ${s.browser}`);
    await load();
  } catch (e) {
    toast(e.message, 'error');
    await load();
  }
  busy.value = false;
}
async function signOutOthers() {
  if (!confirm(`Sign out of ${others.value} other ${plural(others.value, 'session')}? This browser stays signed in.`)) return;
  busy.value = true;
  await attempt(async () => {
    const r = await post('/api/me/sessions/revoke-others');
    toast(`Signed out of ${r.count} other ${plural(r.count, 'session')}`);
  });
  await load();
  busy.value = false;
}
</script>
<template>
  <section v-if="list" id="sessions" class="card space-y-3 p-4" aria-labelledby="ss-title">
    <h2 id="ss-title" class="text-sm font-semibold">Sessions</h2>
    <p class="text-sm text-slate-600">
      The browsers where you are signed in. Sign out any you do not recognise, then change your password.
      <template v-if="idleText">A session that is not used for {{ idleText }} is signed out.</template>
    </p>
    <ul class="divide-y divide-slate-200 rounded-md border border-slate-200">
      <li v-for="s in list" :key="s.id" class="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 text-sm">
        <div class="min-w-0 flex-1 basis-48">
          <div class="font-medium" :title="s.userAgent">
            {{ s.browser }}<span v-if="s.current" class="chip ml-2 bg-green-100 text-green-800">This browser</span>
          </div>
          <div class="text-xs text-slate-600">
            Signed in {{ when(s.createdAt) }} · last used {{ s.current ? 'now' : ago(s.lastSeenAt) }}
          </div>
        </div>
        <button
          type="button"
          class="btn btn-sm"
          :disabled="busy"
          :aria-label="`Sign out ${s.browser}, signed in ${when(s.createdAt)}${s.current ? ' (this browser)' : ''}`"
          @click="signOut(s)"
        >
          Sign out
        </button>
      </li>
    </ul>
    <button v-if="others" type="button" class="btn" :disabled="busy" @click="signOutOthers">Sign out everywhere else</button>
    <p v-else class="text-xs text-slate-600">You are not signed in anywhere else.</p>
  </section>
</template>
