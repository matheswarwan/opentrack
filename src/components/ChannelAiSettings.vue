<script setup>
// Admin > Settings card: channel AI sessions (workspace switch and external channels), the AI provider status from the
// server environment, and recent AI errors. The two switches are saved with Save settings. The settings form is a v-model
// (v-model:settings): a change hands the parent a new settings object, it is never edited in place.
import { ref, computed, onMounted } from 'vue';
import { get, del } from '../api.js';
import { ago } from '../meta.js';
import { attempt } from '../composables/useAction.js';

const settings = defineModel('settings', { type: Object, required: true });
const field = (key) => computed({ get: () => settings.value[key], set: (v) => (settings.value = { ...settings.value, [key]: v }) });
const channelAi = field('channelAi');
const channelAiExternal = field('channelAiExternal');
const ai = ref(null);
async function load() {
  try {
    ai.value = await get('/api/admin/ai');
  } catch {
    ai.value = null;
  }
}
onMounted(load);
async function clearErrors() {
  await attempt(async () => {
    await del('/api/admin/ai/errors');
    await load();
  });
}
const PROVIDERS = { vertex: 'Gemini on Vertex AI', gemini: 'Gemini API', anthropic: 'Claude (Anthropic API)' };
</script>
<template>
  <div class="card space-y-3 p-4">
    <h2 class="text-sm font-semibold">Channel AI sessions</h2>
    <p class="text-xs text-slate-600">
      Project admins can turn on an AI session for a Slack channel linked to an issue. Every 30 minutes the AI reads new messages and posts
      a short internal note on the issue, with suggested changes that people apply with a click. Nothing is posted back to Slack.
    </p>
    <p v-if="ai" class="text-sm" :class="ai.configured ? 'text-green-700' : 'text-slate-700'">
      <template v-if="ai.configured"
        >AI provider: {{ PROVIDERS[ai.provider] || ai.provider }}, model {{ ai.model
        }}<template v-if="ai.location"> ({{ ai.location }})</template>.</template
      >
      <template v-else>AI is not configured on the server. Set {{ ai.missing }} to turn it on. Until then sessions do nothing.</template>
    </p>
    <label class="flex items-center gap-2 text-sm"><input v-model="channelAi" type="checkbox" /> Allow channel AI sessions</label>
    <label class="flex items-start gap-2 text-sm"
      ><input v-model="channelAiExternal" type="checkbox" class="mt-1" :disabled="!channelAi" />
      <span>Also allow them on external channels (shared with clients)</span></label
    >
    <p class="rounded-md bg-amber-50 p-2 text-xs text-amber-900">
      When a session runs, the issue details, the who-is-who notes and the new Slack messages (names and text) are sent to the AI provider.
      On an external channel that includes messages written by the client. Check your agreement with the client before you allow it.
    </p>
    <div v-if="ai?.errors?.length">
      <div class="flex items-center gap-2">
        <h3 class="label mb-0">Recent AI errors</h3>
        <button type="button" class="link text-xs" @click="clearErrors">Clear</button>
      </div>
      <ul class="space-y-1 text-xs text-slate-600">
        <li v-for="(e, i) in ai.errors" :key="i">
          <span class="text-slate-600">{{ ago(e.at) }}</span> {{ e.provider }}: {{ e.error
          }}<span v-if="e.context"> ({{ e.context }})</span>
        </li>
      </ul>
    </div>
  </div>
</template>
