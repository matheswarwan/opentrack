<script setup>
// Bell with unread count and the notifications panel. `dark` styles it for the black phone bar.
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { session, get, post, api } from '../api.js';
import { ago } from '../meta.js';
import { today, addDays } from '../dates.js';
import Avatar from './Avatar.vue';
import Icon from './Icon.vue';

defineProps({ dark: Boolean });
const router = useRouter();
const route = useRoute();
const open = ref(false);
// The panel is teleported to <body> (inside the sticky top bar it sat under the Roadmap's sticky
// header), so it is placed from the button's position: under it, right-aligned, kept on screen.
const btn = ref(null);
const place = ref({});
function measure() {
  const r = btn.value?.getBoundingClientRect();
  if (!r || window.innerWidth < 640) {
    place.value = {};
    return;
  }
  const w = Math.min(416, window.innerWidth - 16);
  place.value = {
    top: `${r.bottom + 8}px`,
    left: `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`,
    width: `${w}px`,
    right: 'auto',
  };
}
const items = ref([]);
let timer;
async function refreshCount() {
  // a timer, not the person: marked so it does not keep an idle session alive (Admin > Settings > Security)
  try {
    session.unread = (await api('GET', '/api/me', undefined, { background: true })).unreadNotifications;
  } catch {
    /* signed out */
  }
}
onMounted(() => {
  timer = setInterval(refreshCount, 60000);
});
onBeforeUnmount(() => {
  clearInterval(timer);
  window.removeEventListener('resize', measure);
});
onMounted(() => window.addEventListener('resize', measure));
watch(
  () => route.fullPath,
  () => (open.value = false),
);
async function toggle() {
  measure();
  open.value = !open.value;
  if (open.value) items.value = (await get('/api/notifications')).notifications;
}
async function go(n) {
  open.value = false;
  if (!n.read) {
    await post('/api/notifications/read', { ids: [n.id] });
    session.unread = Math.max(0, session.unread - 1);
  }
  if (n.issueKey) router.push(`/browse/${n.issueKey}`);
  else if (n.link && n.link.startsWith('/'))
    router.push(n.link); // e.g. a published status report
  else if (n.type === 'feedback') router.push('/admin/feedback');
  else if (n.type === 'due') router.push(`/issues?assignee=me&category=todo,in_progress&dueBefore=${addDays(today(), 1)}`);
  else if (n.type === 'digest') router.push('/digest');
}
async function readAll() {
  await post('/api/notifications/read', { all: true });
  items.value.forEach((n) => (n.read = true));
  session.unread = 0;
}
</script>
<template>
  <div class="relative">
    <button
      ref="btn"
      class="relative rounded-full p-2"
      :class="dark ? 'text-white hover:bg-white/10' : 'text-slate-700 hover:bg-slate-100'"
      :aria-expanded="open"
      title="Notifications"
      @click="toggle"
    >
      <Icon name="bell" :size="20" /><span class="sr-only">Notifications</span>
      <span
        v-if="session.unread"
        class="absolute -right-0.5 -top-0.5 min-w-[1.1rem] rounded-full bg-accent px-1 text-center text-[10px] font-bold leading-[1.1rem] text-white"
        >{{ session.unread > 99 ? '99+' : session.unread }}<span class="sr-only"> unread</span></span
      >
    </button>
    <Teleport to="body">
      <div v-if="open" class="fixed inset-0 z-40" @click="open = false"></div>
      <section
        v-if="open"
        class="fixed left-2 right-2 top-14 z-50 overflow-hidden rounded-[15px] border border-slate-200 bg-white text-black shadow-xl"
        :style="place"
        aria-label="Notifications"
      >
        <div class="flex items-center justify-between border-b border-slate-200 px-4 py-2.5 text-sm font-semibold">
          Notifications <button class="link text-xs font-normal" @click="readAll">Mark all read</button>
        </div>
        <div class="max-h-[70vh] overflow-y-auto">
          <p v-if="!items.length" class="px-4 py-8 text-center text-sm text-slate-500">You are all caught up.</p>
          <button
            v-for="n in items"
            :key="n.id"
            class="flex w-full gap-2.5 border-b border-slate-100 px-4 py-2.5 text-left text-sm hover:bg-slate-50"
            :class="n.read ? 'text-slate-500' : ''"
            @click="go(n)"
          >
            <Avatar :user="n.actor" :size="24" />
            <span class="flex-1"
              ><span :class="n.read ? '' : 'font-medium'">{{ n.message }}</span
              ><span class="block text-xs text-slate-400">{{ ago(n.createdAt) }}</span></span
            >
            <span v-if="!n.read" class="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent"></span>
          </button>
        </div>
      </section>
    </Teleport>
  </div>
</template>
