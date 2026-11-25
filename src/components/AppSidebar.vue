<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { session, post, toast } from '../api.js';
import { ui, openCreate } from '../ui.js';
import { recentProjectKeys } from '../recent.js';
import { projectList } from '../projects.js';
import Avatar from './Avatar.vue';
import Icon from './Icon.vue';
import CreateIssueModal from './CreateIssueModal.vue';
import FeedbackDialog from './FeedbackDialog.vue';
import NotificationBell from './NotificationBell.vue';
import ProjectSwitcher from './ProjectSwitcher.vue';
import TimerPill from './TimerPill.vue';
import { timerState } from '../timer.js';
import { boardProjectKey } from '../projectSwitch.js';

const router = useRouter();
const route = useRoute();
const q = ref('');
const userOpen = ref(false);
const feedbackOpen = ref(false);
const projects = ref([]);
const recent = ref(recentProjectKeys());
const mobileOpen = ref(false);
let collapsedSaved = false;
try {
  collapsedSaved = localStorage.getItem('it_sidebar') === 'collapsed';
} catch {
  /* storage blocked */
}
const collapsed = ref(collapsedSaved);

function toggleCollapse() {
  collapsed.value = !collapsed.value;
  try {
    localStorage.setItem('it_sidebar', collapsed.value ? 'collapsed' : 'open');
  } catch {
    /* storage blocked */
  }
}
async function loadProjects(refresh = false) {
  try {
    projects.value = await projectList(refresh);
  } catch {
    /* ignore */
  }
}
const onRecent = () => (recent.value = recentProjectKeys());
onMounted(() => {
  window.addEventListener('keydown', onKey);
  window.addEventListener('it-recent', onRecent);
  loadProjects();
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('it-recent', onRecent);
});
watch(
  () => route.fullPath,
  () => {
    mobileOpen.value = false;
    userOpen.value = false;
    // a project made or opened since the list loaded: refresh it for the switcher
    const key = route.path.startsWith('/projects/') ? String(route.params.key || '').toUpperCase() : null;
    if (key && projects.value.length && !projects.value.some((p) => p.key === key)) loadProjects(true);
  },
);
watch(
  () => ui.changes,
  () => {
    if (!projects.value.length) loadProjects();
  },
);
watch(
  () => ui.projects,
  () => loadProjects(),
); // projectsChanged() already emptied the store

function onKey(e) {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable || e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.querySelector('[role=dialog]')) return;
  if (e.key === 'c' && !ui.create) {
    e.preventDefault();
    openCreate();
  }
  if (e.key === '/') {
    e.preventDefault();
    collapsed.value = false;
    mobileOpen.value = true;
    setTimeout(() => document.getElementById('global-search')?.focus(), 0);
  }
  if (e.key === '?') {
    e.preventDefault();
    router.push('/help#shortcuts');
  }
}
function search() {
  const text = q.value.trim();
  if (!text) return;
  q.value = '';
  if (/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(text)) router.push(`/browse/${text.toUpperCase()}`);
  else router.push({ name: 'search', query: { q: text } });
}
async function logout() {
  await post('/api/auth/logout');
  session.user = null;
  router.push('/login');
  toast('Signed out');
}

const nav = computed(() => [
  { to: '/', label: 'My work', icon: 'home', match: (p) => p === '/' },
  { to: '/issues', label: 'Issues', icon: 'list', match: (p) => p.startsWith('/issues') },
  // Board opens the project you are in or opened last; the switcher above changes it
  {
    to: boardKey.value ? `/projects/${boardKey.value}/board` : '/projects',
    label: 'Board',
    icon: 'board',
    match: (p) => /^\/projects\/[^/]+\/board/.test(p),
  },
  { to: '/portfolio', label: 'Portfolio', icon: 'grid', match: (p) => p === '/portfolio' },
  { to: '/roadmap', label: 'Roadmap', icon: 'timeline', match: (p) => p === '/roadmap' },
  { to: '/calendar', label: 'Calendar', icon: 'calendar', match: (p) => p === '/calendar' },
  { to: '/timesheet', label: 'Timesheet', icon: 'clock', match: (p) => p.startsWith('/timesheet') },
  ...(session.user?.role !== 'guest'
    ? [{ to: '/capacity', label: 'Capacity', icon: 'gauge', match: (p) => p.startsWith('/capacity') }]
    : []), // not for guests
  { to: '/reports', label: 'Reports', icon: 'chart', match: (p) => p.startsWith('/reports') },
  ...(session.user?.role !== 'guest' ? [{ to: '/ai', label: 'AI connectors', icon: 'spark', match: (p) => p.startsWith('/ai') }] : []), // no AI connectors for guests
  ...(session.user?.role === 'admin' ? [{ to: '/admin/users', label: 'Admin', icon: 'shield', match: (p) => p.startsWith('/admin') }] : []),
]);
const currentProject = computed(() => (route.path.startsWith('/projects/') ? String(route.params.key || '').toUpperCase() : null));
const boardKey = computed(() => boardProjectKey(currentProject.value, projects.value, recent.value));
const itemCls = (active) => (active ? 'bg-accent text-white' : 'text-white/75 hover:bg-white/10 hover:text-white');
</script>

<template>
  <!-- mobile top bar -->
  <div class="sticky top-0 z-30 flex h-12 items-center gap-2 bg-black px-3 text-white lg:hidden">
    <button class="rounded-full p-1.5 hover:bg-white/10" aria-label="Open menu" @click="mobileOpen = true"><Icon name="menu" /></button>
    <RouterLink to="/" class="flex items-center gap-2 font-display font-medium"
      ><img src="/logo-mark.svg" alt="" class="h-6 w-6" />{{ session.appName }}</RouterLink
    >
    <button class="ml-auto rounded-full p-1.5 hover:bg-white/10" aria-label="Create issue" @click="openCreate()">
      <Icon name="plus" />
    </button>
    <NotificationBell dark />
  </div>
  <!-- running timer: its own row on phones, where the top bar has no room -->
  <div v-if="timerState.timer" class="flex bg-black px-3 pb-2 lg:hidden"><TimerPill dark /></div>
  <div v-if="mobileOpen" class="fixed inset-0 z-40 bg-black/40 lg:hidden" @click="mobileOpen = false"></div>

  <aside
    class="fixed inset-y-0 left-0 z-50 flex flex-col bg-black text-white transition-[width,transform] duration-150 lg:sticky lg:top-0 lg:h-screen lg:translate-x-0"
    :class="[collapsed ? 'lg:w-16' : 'lg:w-60', mobileOpen ? 'w-64 translate-x-0' : 'w-64 -translate-x-full']"
    aria-label="Main navigation"
  >
    <div class="flex h-14 items-center gap-2 px-4">
      <RouterLink to="/" class="flex min-w-0 items-center gap-2.5" :title="session.appName">
        <img src="/logo-mark.svg" alt="" class="h-7 w-7 shrink-0" />
        <span v-if="!collapsed || mobileOpen" class="line-clamp-2 font-display text-[15px] font-medium leading-tight">{{
          session.appName
        }}</span>
      </RouterLink>
      <button
        class="ml-auto hidden rounded-full p-1 text-white/60 hover:bg-white/10 hover:text-white lg:block"
        :aria-label="collapsed ? 'Expand sidebar' : 'Collapse sidebar'"
        @click="toggleCollapse"
      >
        <Icon :name="collapsed ? 'expand' : 'collapse'" :size="16" />
      </button>
      <button class="ml-auto rounded-full p-1 hover:bg-white/10 lg:hidden" aria-label="Close menu" @click="mobileOpen = false">
        <Icon name="x" />
      </button>
    </div>

    <div class="space-y-2 px-3 pb-3">
      <ProjectSwitcher :projects="projects" :recent="recent" :current="boardKey" :compact="collapsed && !mobileOpen" />
      <button class="btn btn-primary w-full" :class="collapsed && !mobileOpen ? 'px-0' : ''" title="Create issue (c)" @click="openCreate()">
        <Icon name="plus" :size="16" /><span v-if="!collapsed || mobileOpen">Create issue</span>
      </button>
      <div v-if="!collapsed || mobileOpen" class="relative">
        <span class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-white/65"><Icon name="search" :size="15" /></span>
        <input
          id="global-search"
          v-model="q"
          class="input rounded-full border-white/25 bg-white/10 py-1 pl-8 text-white placeholder:text-white/65 focus:border-white focus:ring-white/20"
          placeholder="Search or KEY-12"
          @keydown.enter="search"
        />
      </div>
    </div>

    <nav class="flex-1 space-y-0.5 overflow-y-auto px-3 text-sm">
      <RouterLink
        v-for="n in nav"
        :key="n.to"
        :to="n.to"
        class="flex items-center gap-3 rounded-full px-3 py-2 font-medium"
        :class="itemCls(n.match(route.path))"
        :title="n.label"
      >
        <Icon :name="n.icon" /><span v-if="!collapsed || mobileOpen">{{ n.label }}</span>
      </RouterLink>
    </nav>

    <div class="space-y-0.5 border-t border-white/10 px-3 py-3 text-sm">
      <RouterLink
        v-if="session.user?.role !== 'viewer' && session.user?.role !== 'guest'"
        to="/trash"
        class="flex items-center gap-3 rounded-full px-3 py-2"
        :class="itemCls(route.path === '/trash')"
        title="Trash: restore deleted issues"
        ><Icon name="trash" /><span v-if="!collapsed || mobileOpen">Trash</span></RouterLink
      >
      <RouterLink
        to="/help"
        class="flex items-center gap-3 rounded-full px-3 py-2"
        :class="itemCls(route.path === '/help')"
        title="Help (?)"
        ><Icon name="help" /><span v-if="!collapsed || mobileOpen">Help</span></RouterLink
      >
      <button
        class="flex w-full items-center gap-3 rounded-full px-3 py-2"
        :class="itemCls(false)"
        title="Send feedback"
        @click="feedbackOpen = true"
      >
        <Icon name="chat" /><span v-if="!collapsed || mobileOpen">Feedback</span>
      </button>
      <div class="relative">
        <button
          class="flex w-full items-center gap-2.5 rounded-full px-2 py-1.5 text-left hover:bg-white/10"
          :aria-label="collapsed && !mobileOpen ? `Account: ${session.user.name}` : undefined"
          @click="userOpen = !userOpen"
        >
          <Avatar :user="session.user" :size="28" />
          <span v-if="!collapsed || mobileOpen" class="min-w-0 flex-1"
            ><span class="block truncate font-medium">{{ session.user.name }}</span
            ><span class="block truncate text-xs capitalize text-white/70">{{ session.user.role }}</span></span
          >
        </button>
        <div v-if="userOpen" class="fixed inset-0 z-40" @click="userOpen = false"></div>
        <div
          v-if="userOpen"
          class="absolute bottom-full left-0 z-50 mb-1 w-56 rounded-[15px] border border-slate-200 bg-white py-1 text-sm text-black shadow-lg"
        >
          <div class="border-b border-slate-100 px-3 py-2">
            <div class="font-medium">{{ session.user.name }}</div>
            <div class="truncate text-xs text-slate-500">{{ session.user.email }}</div>
          </div>
          <RouterLink to="/profile" class="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-100"
            ><Icon name="user" :size="16" />Profile and notifications</RouterLink
          >
          <button class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-100" @click="logout">
            <Icon name="logout" :size="16" />Sign out
          </button>
        </div>
      </div>
    </div>
  </aside>

  <CreateIssueModal v-if="ui.create" />
  <FeedbackDialog v-if="feedbackOpen" @close="feedbackOpen = false" />
</template>
