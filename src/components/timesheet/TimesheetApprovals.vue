<script setup>
// Timesheet > Approvals: the submitted weeks waiting for the signed-in person (TimesheetView loads them and
// owns the approve/reject dialog).
import { computed } from 'vue';
import { session } from '../../api.js';
import { fmtDate, ago } from '../../meta.js';
import { fmtHours } from '../../dates.js';
import Avatar from '../Avatar.vue';
import Skeleton from '../Skeleton.vue';

defineProps({ approvals: { type: Array, default: null } }); // null while loading
const emit = defineEmits(['decide']); // (week, 'approve' | 'reject')
const isAdmin = computed(() => session.user?.role === 'admin');
const fmt = (h) => (h ? fmtHours(h) : '');
const askDecision = (week, verb) => emit('decide', week, verb);
</script>

<template>
  <section aria-labelledby="ts-approvals">
    <h2 id="ts-approvals" class="sr-only">Weeks waiting for your approval</h2>
    <p class="mb-3 text-sm text-slate-600">
      Weeks people submitted that you can approve: workspace admins see every week, project leads the weeks with time logged on their
      projects. An approved week is locked; reject one to send it back with a comment.
    </p>
    <Skeleton v-if="!approvals" card :rows="3" />
    <p v-else-if="!approvals.length" class="card px-3 py-10 text-center text-sm text-slate-500">No weeks are waiting for you.</p>
    <ul v-else class="space-y-3">
      <li v-for="w in approvals" :key="w.id" class="card p-3">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Avatar :user="w.user" :size="26" label="full" class="font-semibold" />
          <span class="text-sm text-slate-700">{{ fmtDate(w.weekStart) }} to {{ fmtDate(w.weekEnd) }}</span>
          <span class="text-sm font-semibold">{{ fmt(w.total) || 0 }}h</span>
          <span class="text-xs text-slate-600">submitted {{ ago(w.submittedAt) }}</span>
          <div class="ml-auto flex flex-wrap gap-2">
            <RouterLink
              v-if="isAdmin"
              :to="{ path: '/timesheet', query: { week: w.weekStart, user: w.user.id === session.user.id ? undefined : w.user.id } }"
              class="btn btn-sm btn-ghost"
              >Open week</RouterLink
            >
            <button
              class="btn btn-sm btn-danger"
              :aria-label="`Reject the week of ${w.weekStart} of ${w.user.name}`"
              @click="askDecision(w, 'reject')"
            >
              Reject
            </button>
            <button
              class="btn btn-sm btn-primary"
              :aria-label="`Approve the week of ${w.weekStart} of ${w.user.name}`"
              @click="askDecision(w, 'approve')"
            >
              Approve
            </button>
          </div>
        </div>
        <ul class="mt-2 space-y-1 text-sm">
          <li v-if="!w.projects.length" class="text-slate-500">No time logged in this week.</li>
          <li v-for="p in w.projects" :key="p.key || 'other'" class="flex items-center gap-2">
            <span class="w-16 shrink-0 truncate font-medium">{{ p.key || 'Other' }}</span>
            <span class="min-w-0 flex-1 truncate text-slate-700">{{ p.name }}</span>
            <span class="w-14 text-right tabular-nums">{{ fmt(p.hours) }}h</span>
          </li>
        </ul>
      </li>
    </ul>
  </section>
</template>
