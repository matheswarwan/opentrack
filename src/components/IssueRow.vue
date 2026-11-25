<script setup>
import TypeIcon from './TypeIcon.vue';
import PriorityIcon from './PriorityIcon.vue';
import StatusBadge from './StatusBadge.vue';
import Avatar from './Avatar.vue';
import BlockedBadge from './BlockedBadge.vue';
import { fmtDate } from '../meta.js';
defineProps({ issue: Object, showProject: Boolean });
defineEmits(['open']);
</script>
<template>
  <div class="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50" @click="$emit('open', issue)">
    <TypeIcon :type="issue.type" />
    <span class="w-20 shrink-0 font-medium text-slate-500">{{ issue.key }}</span>
    <span class="flex-1 truncate">{{ issue.title }}</span>
    <BlockedBadge :issue="issue" compact />
    <span v-if="issue.dueDate" class="shrink-0 text-xs" :class="issue.overdue ? 'font-semibold text-red-700' : 'text-slate-500'">{{
      fmtDate(issue.dueDate)
    }}</span>
    <PriorityIcon :priority="issue.priority" />
    <StatusBadge :status="issue.status" />
    <Avatar :user="issue.assignee" :size="22" label="short" class="w-28 text-slate-600" />
  </div>
</template>
