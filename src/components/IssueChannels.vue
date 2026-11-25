<script setup>
// Issue section: Slack channels linked to this issue, their AI sessions (project admins switch them), and the
// changes the AI suggested ("Suggested by AI": Apply or Dismiss). Not shown to guests. See server/routes/channelAi.js.
import { ref, watch, computed } from 'vue';
import { get, post, patch, del, toast } from '../api.js';
import { ago, fmtDateTime } from '../meta.js';
import { attempt } from '../composables/useAction.js';
import { plural } from '../plural.js';

const props = defineProps({ issueKey: { type: String, required: true } });
const emit = defineEmits(['changed']);
const data = ref(null);
const form = ref(null);
const editing = ref(null); // { id, prompt }
const busy = ref('');

async function load() {
  try {
    data.value = await get(`/api/issues/${props.issueKey}/channels`);
  } catch {
    data.value = null;
  }
}
watch(
  () => props.issueKey,
  () => {
    form.value = null;
    editing.value = null;
    load();
  },
  { immediate: true },
);
defineExpose({ load });

const state = computed(() => data.value?.state || {});
const notice = computed(() => {
  const s = state.value;
  if (!data.value?.links.length) return '';
  if (!s.aiConfigured) return 'AI is not configured on the server, so AI sessions do not run.';
  if (!s.enabled) return 'Channel AI sessions are turned off for the workspace (Admin > Settings).';
  if (!s.slackConnected) return 'Slack is not connected or is turned off, so AI sessions do not run.';
  return '';
});
const blockedExternal = (l) => l.channel.kind === 'external' && !state.value.external;

async function act(key, fn, ok) {
  busy.value = key;
  try {
    await fn();
    if (ok) toast(ok);
    await load();
    return true;
  } catch (e) {
    toast(e.message, 'error');
    return false;
  } finally {
    busy.value = '';
  }
}
function startLink() {
  form.value = { projectChannelId: data.value.channels[0]?.id || '', messageUrl: '', prompt: '' };
}
const saveLink = () =>
  act(
    'link',
    async () => {
      await post(`/api/issues/${props.issueKey}/channels`, {
        projectChannelId: form.value.projectChannelId,
        messageUrl: form.value.messageUrl.trim() || undefined,
        prompt: form.value.prompt,
      });
      form.value = null;
    },
    'Channel linked',
  );
const toggle = (l, field, value) =>
  act(
    `${field}-${l.id}`,
    () => patch(`/api/channel-links/${l.id}`, { [field]: value }),
    field === 'sessionOn' ? (value ? 'AI session on' : 'AI session off') : null,
  );
const savePrompt = () =>
  act(
    `prompt-${editing.value.id}`,
    async () => {
      await patch(`/api/channel-links/${editing.value.id}`, { prompt: editing.value.prompt });
      editing.value = null;
    },
    'Saved',
  );
async function remove(l) {
  if (!confirm(`Remove the link to #${l.channel.name}? Its waiting suggestions are dismissed.`)) return;
  await act(`remove-${l.id}`, () => del(`/api/channel-links/${l.id}`));
}
async function runNow(l) {
  busy.value = `run-${l.id}`;
  await attempt(async () => {
    const r = await post(`/api/channel-links/${l.id}/run`);
    const x = r.result;
    toast(
      x.status === 'ok'
        ? `Read ${x.messages} ${plural(x.messages, 'message')}, ${x.suggestions} ${plural(x.suggestions, 'suggestion')}`
        : x.status === 'nothing_new'
          ? 'No new messages'
          : x.error || 'Could not run',
      x.status === 'error' ? 'error' : 'ok',
    );
    await load();
    if (x.status === 'ok') emit('changed');
  });
  busy.value = '';
}
async function decide(s, what) {
  if (await act(`${what}-${s.id}`, () => post(`/api/ai-suggestions/${s.id}/${what}`), what === 'apply' ? 'Applied' : 'Dismissed')) {
    if (what === 'apply') emit('changed');
  }
}

function lastText(l) {
  if (!l.lastRunAt) return l.sessionOn ? 'Not run yet' : '';
  const when = ago(l.lastRunAt);
  if (l.lastStatus === 'ok') {
    const r = l.lastResult || {};
    return `${when}: ${r.messages || 0} new ${plural(r.messages, 'message')}, ${r.suggestions || 0} ${plural(r.suggestions, 'suggestion')}`;
  }
  if (l.lastStatus === 'nothing_new') return `${when}: no new messages`;
  return `${when}: failed`;
}
function suggestionText(s) {
  switch (s.kind) {
    case 'status':
      return `Move to ${s.value}`;
    case 'assignee':
      return `Assign to ${s.value}`;
    case 'dueDate':
      return `Set the due date to ${s.value}`;
    case 'priority':
      return `Set the priority to ${s.value}`;
    case 'subtask':
      return `Add a sub-task: ${s.value}`;
    case 'comment':
      return `Add an internal note: ${s.value}`;
    default:
      return s.value;
  }
}
</script>
<template>
  <section v-if="data && (data.links.length || data.canLink)" class="mb-5">
    <div class="mb-1 flex flex-wrap items-center gap-2">
      <h2 class="text-sm font-semibold text-slate-700">Channels</h2>
      <button v-if="data.canLink && data.channels.length && !form" type="button" class="link text-xs" @click="startLink">
        Link a channel
      </button>
    </div>
    <p v-if="data.canLink && !data.channels.length && !data.links.length" class="text-sm text-slate-600">
      No Slack channels are linked to this project. Project admins add them under Project settings &gt; Channels.
    </p>
    <p v-if="notice" class="mb-2 rounded-md bg-slate-100 p-2 text-xs text-slate-700">{{ notice }}</p>

    <form v-if="form" class="mb-3 space-y-2 rounded-lg border border-slate-200 p-3" @submit.prevent="saveLink">
      <div class="flex flex-wrap gap-2">
        <div class="min-w-0 flex-1">
          <label class="label" for="ic-channel">Channel</label>
          <select id="ic-channel" v-model="form.projectChannelId" class="input" required>
            <option v-for="c in data.channels" :key="c.id" :value="c.id">
              #{{ c.name || c.channelId }} ({{ c.kind === 'external' ? 'External' : 'Internal' }})
            </option>
          </select>
        </div>
        <div class="min-w-0 flex-1">
          <label class="label" for="ic-thread">Only one thread (optional)</label>
          <input id="ic-thread" v-model="form.messageUrl" class="input" placeholder="Paste a Slack message link" />
        </div>
      </div>
      <div>
        <label class="label" for="ic-prompt">Who is who in the channel</label>
        <textarea
          id="ic-prompt"
          v-model="form.prompt"
          class="input"
          rows="3"
          maxlength="3000"
          placeholder="Dana (client PM) decides scope. Raj is our developer. Messages from Priya are QA findings."
        ></textarea>
        <p class="mt-1 text-xs text-slate-600">The AI reads this with the messages to understand people's roles.</p>
      </div>
      <div class="flex gap-2">
        <button class="btn btn-primary btn-sm" :disabled="busy === 'link'">Link</button
        ><button type="button" class="btn btn-sm" @click="form = null">Cancel</button>
      </div>
    </form>

    <ul class="space-y-2">
      <li v-for="l in data.links" :key="l.id" class="rounded-lg border border-slate-200 p-3 text-sm">
        <div class="flex flex-wrap items-center gap-2">
          <strong class="font-medium">#{{ l.channel.name || l.channel.id }}</strong>
          <span class="chip" :class="l.channel.kind === 'external' ? 'bg-amber-100 text-amber-900' : 'bg-slate-100 text-slate-700'">{{
            l.channel.kind === 'external' ? 'External' : 'Internal'
          }}</span>
          <a v-if="l.permalink" :href="l.permalink" target="_blank" rel="noopener" class="link text-xs">One thread</a>
          <span class="text-xs text-slate-600">AI session: {{ l.sessionOn ? 'On' : 'Off' }}</span>
          <button
            v-if="l.canRemove"
            type="button"
            class="ml-auto text-xs text-slate-600 hover:text-red-700 hover:underline"
            :aria-label="`Remove the link to #${l.channel.name}`"
            @click="remove(l)"
          >
            Remove
          </button>
        </div>
        <div v-if="data.canAdmin" class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
          <label class="flex items-center gap-1.5 text-xs"
            ><input
              type="checkbox"
              :checked="l.sessionOn"
              :disabled="busy === `sessionOn-${l.id}`"
              @change="toggle(l, 'sessionOn', $event.target.checked)"
            />AI session on</label
          >
          <label class="flex items-center gap-1.5 text-xs" title="Status, assignee, due date and priority changes always need a click"
            ><input
              type="checkbox"
              :checked="l.autoApply"
              :disabled="busy === `autoApply-${l.id}`"
              @change="toggle(l, 'autoApply', $event.target.checked)"
            />Add notes and sub-tasks without asking</label
          >
          <button type="button" class="btn btn-sm" :disabled="busy === `run-${l.id}`" @click="runNow(l)">
            {{ busy === `run-${l.id}` ? 'Reading...' : 'Run now' }}
          </button>
        </div>
        <p v-if="blockedExternal(l) && l.sessionOn" class="mt-1 text-xs text-amber-900">
          AI sessions on external channels are not allowed in this workspace, so this one does not run.
        </p>
        <p v-if="lastText(l)" class="mt-1 text-xs text-slate-600" :title="fmtDateTime(l.lastRunAt)">Last run {{ lastText(l) }}</p>
        <p v-if="l.lastStatus === 'error' && l.lastError" class="mt-1 text-xs text-red-700">{{ l.lastError }}</p>
        <div class="mt-2">
          <div v-if="editing?.id === l.id" class="space-y-1">
            <label class="label" :for="`ic-edit-${l.id}`">Who is who in the channel</label>
            <textarea :id="`ic-edit-${l.id}`" v-model="editing.prompt" class="input" rows="3" maxlength="3000"></textarea>
            <div class="flex gap-2">
              <button type="button" class="btn btn-primary btn-sm" @click="savePrompt">Save</button
              ><button type="button" class="btn btn-sm" @click="editing = null">Cancel</button>
            </div>
          </div>
          <template v-else>
            <p class="text-xs font-semibold text-slate-600">Who is who</p>
            <p class="whitespace-pre-line text-sm text-slate-700">{{ l.prompt || 'Not written yet.' }}</p>
            <button
              v-if="l.canEditPrompt"
              type="button"
              class="link text-xs"
              :aria-label="`Edit who is who for #${l.channel.name}`"
              @click="editing = { id: l.id, prompt: l.prompt }"
            >
              Edit
            </button>
          </template>
        </div>
      </li>
    </ul>

    <div v-if="data.suggestions.length" class="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <h3 class="mb-2 text-sm font-semibold text-slate-700">Suggested by AI</h3>
      <ul class="space-y-2">
        <li v-for="s in data.suggestions" :key="s.id" class="flex flex-wrap items-start gap-2 text-sm">
          <div class="min-w-0 flex-1">
            <div class="break-words">{{ suggestionText(s) }}</div>
            <div class="text-xs text-slate-600">
              {{ s.reason }}<span v-if="s.channel"> (from #{{ s.channel }}, {{ ago(s.createdAt) }})</span>
            </div>
          </div>
          <template v-if="data.canApply">
            <button
              type="button"
              class="btn btn-sm btn-primary"
              :disabled="busy === `apply-${s.id}`"
              :aria-label="`Apply: ${suggestionText(s)}`"
              @click="decide(s, 'apply')"
            >
              Apply
            </button>
            <button
              type="button"
              class="btn btn-sm"
              :disabled="busy === `dismiss-${s.id}`"
              :aria-label="`Dismiss: ${suggestionText(s)}`"
              @click="decide(s, 'dismiss')"
            >
              Dismiss
            </button>
          </template>
        </li>
      </ul>
      <p class="mt-2 text-xs text-slate-600">Written by AI from Slack messages. Check each one before you apply it.</p>
    </div>
  </section>
</template>
