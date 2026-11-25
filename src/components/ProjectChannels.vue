<script setup>
// Project settings card: Slack channels linked to this project, each internal (our team) or external (shared with the
// client). Issues link to these channels; an AI session can then summarize them (server/lib/channelAi.js).
import { ref, onMounted } from 'vue';
import { get, post, patch, del, toast } from '../api.js';
import { attempt } from '../composables/useAction.js';
import { plural } from '../plural.js';

const props = defineProps({ projectKey: { type: String, required: true } });
const list = ref(null);
const state = ref(null);
const slackChannels = ref(null);
const loadingSlack = ref(false);
const slackError = ref('');
const form = ref({ channelId: '', kind: 'internal' });
const busy = ref(false);

async function load() {
  await attempt(async () => {
    const r = await get(`/api/projects/${props.projectKey}/channels`);
    list.value = r.channels;
    state.value = r.state;
  });
}
async function loadSlack(refresh = false) {
  loadingSlack.value = true;
  slackError.value = '';
  try {
    slackChannels.value = (await get(`/api/projects/${props.projectKey}/slack/channels${refresh ? '?refresh=1' : ''}`)).channels;
  } catch (e) {
    slackError.value = e.message;
  } finally {
    loadingSlack.value = false;
  }
}
onMounted(async () => {
  await load();
  if (state.value?.slackConnected) loadSlack();
});

async function add() {
  const ch = slackChannels.value?.find((c) => c.id === form.value.channelId);
  if (!ch) return;
  busy.value = true;
  await attempt(async () => {
    await post(`/api/projects/${props.projectKey}/channels`, { channelId: ch.id, channelName: ch.name, kind: form.value.kind });
    toast(`#${ch.name} linked to the project`);
    form.value = { channelId: '', kind: 'internal' };
    await load();
  });
  busy.value = false;
}
async function setKind(c, kind) {
  await attempt(async () => {
    await patch(`/api/project-channels/${c.id}`, { kind });
    await load();
  });
}
async function remove(c) {
  const msg = c.links
    ? `Remove #${c.name}? Its ${c.links} ${plural(c.links, 'link')} on issues and their AI sessions are removed too.`
    : `Remove #${c.name}?`;
  if (!confirm(msg)) return;
  await attempt(async () => {
    await del(`/api/project-channels/${c.id}`);
    await load();
  });
}
const available = () => (slackChannels.value || []).filter((c) => !list.value?.some((x) => x.channelId === c.id));
</script>
<template>
  <div v-if="list" class="card space-y-3 p-4">
    <h2 class="text-sm font-semibold">Channels</h2>
    <p class="text-xs text-slate-600">
      Slack channels for this project. Mark a channel <strong>internal</strong> when only our team is in it, or
      <strong>external</strong> when it is shared with the client. People link these channels to issues, and a project admin can start an AI
      session that reads new messages and summarizes them on the issue.
    </p>
    <p v-if="state && !state.aiConfigured" class="rounded-md bg-slate-100 p-2 text-xs text-slate-700">
      AI is not configured on the server, so AI sessions cannot run yet. Channels can still be linked.
    </p>
    <p v-else-if="state && !state.enabled" class="rounded-md bg-slate-100 p-2 text-xs text-slate-700">
      Channel AI sessions are turned off for the workspace. An admin can turn them on under Admin &gt; Settings.
    </p>
    <p v-else-if="state && !state.external" class="text-xs text-slate-600">
      AI sessions on external channels are not allowed in this workspace (Admin &gt; Settings).
    </p>

    <ul v-if="list.length" class="divide-y divide-slate-100">
      <li v-for="c in list" :key="c.id" class="flex flex-wrap items-center gap-2 py-1.5 text-sm">
        <span class="min-w-0 flex-1 truncate font-medium">#{{ c.name || c.channelId }}</span>
        <span class="text-xs text-slate-600">{{ c.links }} issue {{ plural(c.links, 'link') }}</span>
        <select
          :value="c.kind"
          class="input w-32 py-1"
          :aria-label="`Kind of #${c.name || c.channelId}`"
          @change="setKind(c, $event.target.value)"
        >
          <option value="internal">Internal</option>
          <option value="external">External</option>
        </select>
        <button type="button" class="btn btn-sm btn-danger" :aria-label="`Remove #${c.name || c.channelId}`" @click="remove(c)">
          Remove
        </button>
      </li>
    </ul>
    <p v-else class="text-sm text-slate-600">No channels yet.</p>

    <p v-if="state && !state.slackConnected" class="text-sm text-slate-600">
      Slack is not connected or is turned off. A workspace admin can set it up under Admin &gt; Slack.
    </p>
    <form v-else class="space-y-2" @submit.prevent="add">
      <div class="flex flex-wrap gap-2">
        <div class="min-w-0 flex-1">
          <label class="label" for="pch-add">Add a channel</label>
          <select id="pch-add" v-model="form.channelId" class="input" :disabled="loadingSlack">
            <option value="">Choose a channel</option>
            <option v-for="c in available()" :key="c.id" :value="c.id">#{{ c.name }}{{ c.isPrivate ? ' (private)' : '' }}</option>
          </select>
        </div>
        <div class="w-36">
          <label class="label" for="pch-kind">Kind</label>
          <select id="pch-kind" v-model="form.kind" class="input">
            <option value="internal">Internal</option>
            <option value="external">External (client)</option>
          </select>
        </div>
      </div>
      <p v-if="form.kind === 'external'" class="rounded-md bg-amber-50 p-2 text-xs text-amber-900">
        External: the client can read this channel. If an AI session is turned on for it, client messages are sent to the AI provider.
        Nothing is ever posted back to Slack.
      </p>
      <p v-if="slackError" class="text-sm text-red-700">{{ slackError }}</p>
      <div class="flex flex-wrap gap-2">
        <button class="btn btn-primary" :disabled="busy || !form.channelId">Add channel</button>
        <button type="button" class="btn" :disabled="loadingSlack" @click="loadSlack(true)">Refresh list</button>
      </div>
      <p class="text-xs text-slate-600">
        The bot must be in a channel to read it. In Slack, open the channel and type /invite @{{ state?.botName || 'app-name' }}.
      </p>
    </form>
  </div>
</template>
