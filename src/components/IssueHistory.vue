<script setup>
// Issue page > History tab: field changes, newest first.
import { ago, FIELD_LABELS } from '../meta.js';
import { historyField } from '../fields.js';
import Avatar from './Avatar.vue';

defineProps({ history: { type: Array, required: true } });

const historyText = (h) => {
  if (h.field === 'recurring') return h.to;
  if (h.field === 'attachment' || h.field === 'internal_attachment') return h.to ? `added ${h.to}` : `removed ${h.from}`;
  if (h.field === 'restored') return '';
  if (h.field === 'created' && String(h.to || '').startsWith('Imported from Jira')) return h.to;
  if (h.field === 'description' || h.field === 'created' || h.field === 'link') return h.field === 'link' ? `linked: ${h.to}` : '';
  return `${h.from ?? 'None'} → ${h.to ?? 'None'}`;
};
</script>
<template>
  <div class="space-y-2">
    <div v-for="h in [...history].reverse()" :key="h.id" class="flex gap-2 text-sm">
      <Avatar :user="h.actor" :size="22" />
      <div>
        <strong class="font-medium">{{ h.actor?.name || 'Former user' }}</strong>
        {{ historyField(h.field) ? `changed ${historyField(h.field)}` : FIELD_LABELS[h.field] || h.field }}
        <span
          v-if="h.source === 'mcp'"
          class="chip bg-violet-100 text-violet-900"
          title="Made by an AI assistant (MCP) acting for this person"
          >via AI assistant</span
        >
        <span class="text-xs text-slate-400">{{ ago(h.createdAt) }}</span>
        <div v-if="historyText(h)" class="text-slate-600">{{ historyText(h) }}</div>
      </div>
    </div>
  </div>
</template>
