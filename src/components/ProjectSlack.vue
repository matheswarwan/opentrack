<script setup>
// Project settings card: Slack channel for this project and which events post there.
import { ref, onMounted } from 'vue';
import { get, put, toast } from '../api.js';
import { attempt } from '../composables/useAction.js';

const props = defineProps({ projectKey: { type: String, required: true } });
const EVENT_LABELS = {
  issue_created: 'Issue created',
  status_changed: 'Status changed',
  assignee_changed: 'Assignee changed',
  comment_added: 'Comment added',
  sprint_started: 'Sprint started',
  sprint_completed: 'Sprint completed',
};
const info = ref(null);
const channels = ref(null);
const channelId = ref('');
const events = ref([]);
const loadingChannels = ref(false);
const channelError = ref('');
const busy = ref(false);

const base = () => `/api/projects/${props.projectKey}/slack`;
async function loadChannels(refresh = false) {
  loadingChannels.value = true;
  channelError.value = '';
  try {
    channels.value = (await get(`${base()}/channels${refresh ? '?refresh=1' : ''}`)).channels;
  } catch (e) {
    channelError.value = e.message;
  } finally {
    loadingChannels.value = false;
  }
}
onMounted(async () => {
  try {
    info.value = await get(base());
  } catch {
    info.value = null;
    return;
  }
  channelId.value = info.value.channel?.id || '';
  events.value = [...info.value.events];
  if (info.value.connected) loadChannels();
});

async function save() {
  busy.value = true;
  await attempt(async () => {
    const ch = channels.value?.find((c) => c.id === channelId.value);
    const r = await put(base(), {
      channelId: channelId.value || null,
      channelName: ch?.name || (channelId.value === info.value.channel?.id ? info.value.channel.name : null),
      events: events.value,
    });
    info.value.channel = r.channel;
    toast(r.channel ? `Updates go to #${r.channel.name || r.channel.id}` : 'Slack channel removed');
  });
  busy.value = false;
}
</script>
<template>
  <div v-if="info" class="card space-y-3 p-4">
    <h2 class="text-sm font-semibold">Slack</h2>
    <p v-if="!info.connected" class="text-sm text-slate-600">
      Slack is not connected for this workspace. A workspace admin can connect it under Admin &gt; Slack.
    </p>
    <form v-else class="space-y-3" @submit.prevent="save">
      <div>
        <label class="label" for="pslack-ch">Channel for project updates</label>
        <div class="flex gap-2">
          <select id="pslack-ch" v-model="channelId" class="input" :disabled="loadingChannels">
            <option value="">No channel</option>
            <option v-if="info.channel && !channels?.some((c) => c.id === info.channel.id)" :value="info.channel.id">
              #{{ info.channel.name || info.channel.id }}
            </option>
            <option v-for="c in channels || []" :key="c.id" :value="c.id">#{{ c.name }}{{ c.isPrivate ? ' (private)' : '' }}</option>
          </select>
          <button type="button" class="btn" :disabled="loadingChannels" @click="loadChannels(true)">Refresh</button>
        </div>
        <p v-if="loadingChannels" class="mt-1 text-xs text-slate-500">Loading channels...</p>
        <p v-if="channelError" class="mt-1 text-sm text-red-700">{{ channelError }}</p>
        <p class="mt-1 text-xs text-slate-500">
          Lists public channels and the private channels the app was invited to. To use a private channel, open it in Slack and type /invite
          @{{ info.botName || 'app-name' }}, then click Refresh.
        </p>
      </div>
      <fieldset v-if="channelId">
        <legend class="label">Post to the channel when</legend>
        <div class="grid grid-cols-2 gap-1">
          <label v-for="e in info.allEvents" :key="e" class="flex items-center gap-2 text-sm"
            ><input v-model="events" type="checkbox" :value="e" /> {{ EVENT_LABELS[e] || e }}</label
          >
        </div>
      </fieldset>
      <button class="btn btn-primary" :disabled="busy">Save</button>
    </form>
  </div>
</template>
