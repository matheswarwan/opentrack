<script setup>
// Create issue: fill the summary and description from a Slack message link. Shown only when Slack is connected.
import { ref, onMounted } from 'vue';
import { get, post } from '../api.js';
import { plural } from '../plural.js';

const emit = defineEmits(['import']);
const connected = ref(false);
const open = ref(false);
const url = ref('');
const busy = ref(false);
const error = ref('');
const done = ref('');

onMounted(async () => {
  try {
    connected.value = (await get('/api/slack/status')).connected;
  } catch {
    connected.value = false;
  }
});

const quote = (text) =>
  String(text || '')
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');

function toIssue(m) {
  const first =
    (m.text || '')
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) || `Slack message from ${m.author}`;
  const title = first.length > 120 ? `${first.slice(0, 119)}…` : first;
  const parts = [`**${m.author}** wrote in Slack${m.channel ? ` (#${m.channel})` : ''}:`, '', quote(m.text)];
  if (m.replies?.length) {
    parts.push('', 'Thread:', '');
    for (const r of m.replies) parts.push(quote(`**${r.author}**: ${r.text}`), '>');
    parts.pop();
  }
  parts.push('', `From Slack: ${m.permalink}`);
  return { title, description: parts.join('\n') };
}

async function load() {
  error.value = '';
  done.value = '';
  busy.value = true;
  try {
    const m = await post('/api/slack/message', { url: url.value });
    emit('import', toIssue(m));
    done.value = `Filled in from ${m.author}'s message${m.replies?.length ? ` and ${m.replies.length} ${plural(m.replies.length, 'reply', 'replies')}` : ''}. Check the summary before you create the issue.`;
    url.value = '';
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div v-if="connected" class="rounded-md border border-slate-200 p-2">
    <button v-if="!open" type="button" class="text-sm text-blue-700 hover:underline" @click="open = true">
      From a Slack message: paste the link
    </button>
    <div v-else class="space-y-1">
      <label class="label" for="slack-url">Slack message link</label>
      <div class="flex gap-2">
        <input
          id="slack-url"
          v-model="url"
          class="input"
          placeholder="https://your-workspace.slack.com/archives/C.../p..."
          @keydown.enter.prevent="url && load()"
        />
        <button type="button" class="btn" :disabled="busy || !url" @click="load">{{ busy ? 'Loading...' : 'Use message' }}</button>
      </div>
      <p class="text-xs text-slate-500">In Slack, open the message menu and choose Copy link. The Slack app must be in the channel.</p>
      <p v-if="error" class="text-sm text-red-700">{{ error }}</p>
      <p v-if="done" class="text-sm text-green-700">{{ done }}</p>
    </div>
  </div>
</template>
