<script setup>
import { ref } from 'vue';
import { get, post, put, patch, del } from '../../api.js';
import { useAction } from '../../composables/useAction.js';
import { useLoad } from '../../composables/useLoad.js';
import LoadState from '../../components/LoadState.vue';

const token = ref('');
const signingSecret = ref('');
const testResult = ref(null);
const { busy, run: act } = useAction();

const { data: s, loading, error: loadError, reload: load } = useLoad(() => get('/api/admin/slack'));

const test = () =>
  act(async () => {
    testResult.value = null;
    try {
      const r = await post('/api/admin/slack/test', token.value ? { token: token.value } : {});
      testResult.value = { ok: true, text: `Connected to ${r.team} as @${r.botName}.` };
    } catch (e) {
      testResult.value = { ok: false, text: e.message };
    }
  });
const save = () =>
  act(
    async () => {
      s.value = await put('/api/admin/slack', { token: token.value });
      token.value = '';
      testResult.value = null;
    },
    { ok: 'Slack connected' },
  );
const remove = () => {
  if (
    !confirm(
      'Remove the Slack token? Channel updates and Slack messages stop until a new token is saved. Project channel choices are kept.',
    )
  )
    return;
  act(
    async () => {
      s.value = await del('/api/admin/slack');
    },
    { ok: 'Slack token removed' },
  );
};
const setEnabled = (enabled) =>
  act(
    async () => {
      s.value = await patch('/api/admin/slack', { enabled });
    },
    { ok: enabled ? 'Slack turned on' : 'Slack turned off' },
  );
const saveSecret = () =>
  act(
    async () => {
      s.value = await put('/api/admin/slack/signing-secret', { secret: signingSecret.value.trim() });
      signingSecret.value = '';
    },
    { ok: 'Signing secret saved' },
  );
const removeSecret = () => {
  if (!confirm('Remove the signing secret? The /tracker command and the message shortcut stop working until a new one is saved.')) return;
  act(
    async () => {
      s.value = await del('/api/admin/slack/signing-secret');
    },
    { ok: 'Signing secret removed' },
  );
};
const clearErrors = () =>
  act(async () => {
    s.value = await del('/api/admin/slack/errors');
  });
const when = (iso) => new Date(iso).toLocaleString();
</script>
<template>
  <LoadState v-if="!s" :loading="loading" :error="loadError" card @retry="load" />
  <div v-else class="max-w-3xl space-y-4">
    <div class="card space-y-3 p-4">
      <h2 class="text-sm font-semibold">Connection</h2>
      <template v-if="s.connected">
        <p class="text-sm">
          Connected<span v-if="s.team">
            to <strong>{{ s.team }}</strong></span
          ><span v-if="s.botName">
            as <strong>@{{ s.botName }}</strong></span
          >. Token ending in <code>{{ s.tokenLast4 }}</code>.
        </p>
        <p v-if="s.managedOnServer" class="text-sm text-slate-600">
          The token is managed on the server (SLACK_BOT_TOKEN). Change or remove it there.
        </p>
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" :checked="s.enabled" :disabled="busy" @change="setEnabled($event.target.checked)" />
          Slack integration on (when off, nothing is sent to Slack and Create issue hides the Slack import; the token is kept)
        </label>
        <div class="flex flex-wrap gap-2">
          <button class="btn" :disabled="busy" @click="test">Test connection</button>
          <button v-if="!s.managedOnServer" class="btn btn-danger" :disabled="busy" @click="remove">Remove token</button>
        </div>
      </template>
      <p v-else class="text-sm text-slate-600">Not connected. Paste a bot token below.</p>

      <form v-if="!s.managedOnServer" class="space-y-2" @submit.prevent="save">
        <label class="label" for="sl-token">{{ s.connected ? 'Replace the bot token' : 'Bot token' }}</label>
        <input id="sl-token" v-model="token" class="input font-mono" placeholder="xoxb-..." autocomplete="off" spellcheck="false" />
        <div class="flex flex-wrap gap-2">
          <button type="button" class="btn" :disabled="busy || !token" @click="test">Test connection</button>
          <button class="btn btn-primary" :disabled="busy || !token">Save</button>
        </div>
        <p class="text-xs text-slate-500">
          Saving checks the token with Slack first. The token stays on the server; only its last 4 characters are shown here.
        </p>
      </form>
      <p v-if="testResult" class="text-sm" :class="testResult.ok ? 'text-green-700' : 'text-red-700'">{{ testResult.text }}</p>
    </div>

    <div class="card space-y-2 p-4 text-sm">
      <h2 class="text-sm font-semibold">Set up the Slack app</h2>
      <ol class="list-decimal space-y-1 pl-5">
        <li>
          Go to <a class="text-blue-700 underline" href="https://api.slack.com/apps" target="_blank" rel="noopener">api.slack.com/apps</a>,
          choose Create New App, then From scratch. Pick your workspace.
        </li>
        <li>Open OAuth &amp; Permissions. Under Bot Token Scopes, add the scopes listed below.</li>
        <li>Click Install to Workspace and allow it.</li>
        <li>Copy the Bot User OAuth Token (it starts with xoxb-) and paste it above.</li>
        <li>
          For private channels, open each channel in Slack and invite the app: <code>/invite @app-name</code>. Public channels work without
          an invite.
        </li>
      </ol>
      <table class="mt-2 w-full text-left text-sm">
        <thead>
          <tr class="text-xs text-slate-500">
            <th class="py-1 pr-3">Scope</th>
            <th class="py-1">Used to</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="x in s.scopes" :key="x.scope" class="border-t border-slate-100">
            <td class="py-1 pr-3 font-mono text-xs">{{ x.scope }}</td>
            <td class="py-1">{{ x.why }}</td>
          </tr>
        </tbody>
      </table>
      <p class="text-xs text-slate-500">
        People get Slack messages for assignments and mentions when their email here matches their Slack email. Each person can turn this
        off under Profile.
      </p>
    </div>

    <div class="card space-y-3 p-4 text-sm">
      <h2 class="text-sm font-semibold">/tracker command and Create issue shortcut</h2>
      <p>
        People can type <code>/tracker create WEB Fix the login page</code>, <code>/tracker WEB-12</code>, <code>/tracker mine</code> or
        <code>/tracker help</code> in Slack, and create an issue from any message (message menu, More actions, Create issue in Tracker).
        They act as the tracker user with the same email as their Slack account, with that person's rights.
      </p>
      <ol class="list-decimal space-y-1 pl-5">
        <li>
          In the Slack app, open <strong>Basic Information</strong> and copy the <strong>Signing Secret</strong> under App Credentials.
          Paste it below. It stays on the server and is never shown again.
        </li>
        <li>
          Open <strong>Slash Commands</strong>, choose Create New Command. Command: <code>/tracker</code>. Request URL:
          <code class="break-all">{{ s.commandsUrl }}</code>. Short description: Tracker issues.
        </li>
        <li>
          Open <strong>Interactivity &amp; Shortcuts</strong> and turn Interactivity on. Request URL:
          <code class="break-all">{{ s.interactivityUrl }}</code>.
        </li>
        <li>
          On the same page, under Shortcuts, choose Create New Shortcut, then On messages. Name: Create issue in Tracker. Callback ID:
          <code>create_issue</code>.
        </li>
        <li>
          Check that the bot token scopes above include <code>commands</code> and <code>users:read.email</code>, then reinstall the app
          (Slack asks for this after these changes).
        </li>
      </ol>
      <p v-if="s.signingSecretOnServer" class="text-slate-600">
        The signing secret is managed on the server (SLACK_SIGNING_SECRET). Change or remove it there.
      </p>
      <template v-else>
        <p>
          Signing secret: <strong>{{ s.signingSecretSet ? 'saved' : 'not set' }}</strong>.
        </p>
        <form class="flex flex-wrap gap-2" @submit.prevent="saveSecret">
          <label class="sr-only" for="sl-secret">Signing secret</label>
          <input
            id="sl-secret"
            v-model="signingSecret"
            class="input min-w-0 flex-1 font-mono"
            type="password"
            placeholder="Signing secret"
            autocomplete="off"
            spellcheck="false"
          />
          <button class="btn btn-primary" :disabled="busy || !signingSecret.trim()">{{ s.signingSecretSet ? 'Replace' : 'Save' }}</button>
          <button v-if="s.signingSecretSet" type="button" class="btn btn-danger" :disabled="busy" @click="removeSecret">Remove</button>
        </form>
      </template>
      <p class="text-xs text-slate-500">
        Requests are accepted only with a valid Slack signature made in the last 5 minutes. Removing the bot token above also removes a
        saved signing secret.
      </p>
    </div>

    <div class="card p-4">
      <div class="mb-2 flex items-center">
        <h2 class="text-sm font-semibold">Recent Slack errors</h2>
        <button v-if="s.errors.length" class="btn btn-sm ml-auto" :disabled="busy" @click="clearErrors">Clear</button>
      </div>
      <p v-if="!s.errors.length" class="text-sm text-slate-500">No failed Slack calls.</p>
      <table v-else class="w-full text-left text-sm">
        <thead>
          <tr class="text-xs text-slate-500">
            <th class="py-1 pr-3">When</th>
            <th class="py-1 pr-3">Call</th>
            <th class="py-1">What happened</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(e, i) in s.errors" :key="i" class="border-t border-slate-100 align-top">
            <td class="whitespace-nowrap py-1 pr-3 text-xs text-slate-500">{{ when(e.at) }}</td>
            <td class="py-1 pr-3 font-mono text-xs">
              {{ e.method }}
              <div class="text-slate-500">{{ e.error }}</div>
            </td>
            <td class="py-1">
              {{ e.explanation }}
              <div v-if="e.context" class="text-xs text-slate-500">{{ e.context }}</div>
            </td>
          </tr>
        </tbody>
      </table>
      <p class="mt-2 text-xs text-slate-500">The last 50 failed calls are kept.</p>
    </div>
  </div>
</template>
