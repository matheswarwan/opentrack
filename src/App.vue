<script setup>
import { computed, watch } from 'vue';
import { useRoute } from 'vue-router';
import { session, toasts } from './api.js';
import AppSidebar from './components/AppSidebar.vue';
import NotificationBell from './components/NotificationBell.vue';
import TransitionDialog from './components/TransitionDialog.vue';
import IssueDrawer from './components/IssueDrawer.vue';
import { closeIssue } from './ui.js';
import TimerPill from './components/TimerPill.vue';
import TimerStopDialog from './components/TimerStopDialog.vue';
import { timerState, watchTimer } from './timer.js';

const route = useRoute();
const bare = computed(() => ['login', 'setup', 'invite', 'status-print'].includes(route.name) || !session.user);
watch(
  () => session.user?.id,
  (id) => {
    if (id) watchTimer();
    else timerState.timer = null;
  },
  { immediate: true },
); // the running issue timer
</script>

<template>
  <div id="app-shell" class="min-h-screen bg-white" :class="bare ? '' : 'lg:flex'">
    <AppSidebar v-if="!bare" />
    <main :class="bare ? '' : 'min-w-0 flex-1'">
      <div
        v-if="!bare"
        class="sticky top-0 z-30 hidden h-12 items-center justify-end border-b border-slate-200 bg-white/95 px-6 backdrop-blur lg:flex"
      >
        <TimerPill class="mr-3" /><NotificationBell />
      </div>
      <p
        v-if="!bare && session.demo"
        class="border-b border-blue-200 bg-blue-50 px-4 py-1.5 text-center text-xs text-slate-700 lg:px-6"
        data-demo-banner
      >
        You are exploring the public demo. Anything you add is visible to other visitors.
      </p>
      <div :class="bare ? '' : 'mx-auto max-w-[1600px] px-4 py-4 lg:px-6 lg:py-5'"><RouterView /></div>
    </main>
    <IssueDrawer
      v-if="!bare && route.query.issue"
      :issue-key="String(route.query.issue)"
      @close="closeIssue"
    /><!-- ?issue=KEY on any page (ui.js openIssue) -->
    <TimerStopDialog v-if="!bare && timerState.stopping && timerState.timer" />
    <TransitionDialog v-if="!bare" /><!-- values a workflow rule asks for (src/workflow.js) -->
    <div class="fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
      <div
        v-for="t in toasts"
        :key="t.id"
        class="rounded-full px-4 py-2 text-sm shadow-lg"
        :class="t.kind === 'error' ? 'bg-red-700 text-white' : t.kind === 'warn' ? 'bg-amber-400 text-black' : 'bg-black text-white'"
        role="status"
      >
        {{ t.message }}
      </div>
    </div>
  </div>
</template>
