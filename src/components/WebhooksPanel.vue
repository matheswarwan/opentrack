<script setup>
// Outgoing webhooks: Project settings > Webhooks (base /api/projects/<KEY>/webhooks) and Admin > Webhooks
// (base /api/admin/webhooks). Server: server/routes/webhooks.js.
import { ref, reactive, watch } from 'vue';
import { get, post, patch, del, toast } from '../api.js';
import { copyText } from '../browser.js';
import { attempt, useAction } from '../composables/useAction.js';
import { plural } from '../plural.js';

const props = defineProps({
  base: { type: String, required: true },
  intro: { type: String, default: '' },
});
const EVENT_LABELS = {
  'issue.created': 'Issue created',
  'issue.updated': 'Issue changed',
  'issue.deleted': 'Issue deleted (to the Trash)',
  'issue.restored': 'Issue restored',
  'comment.created': 'Comment added',
  'sprint.started': 'Sprint started',
  'sprint.completed': 'Sprint completed',
  'release.released': 'Version released',
};
const hooks = ref([]);
const allEvents = ref(Object.keys(EVENT_LABELS));
const editing = ref(null); // null, 'new' or a webhook id
const form = reactive({ name: '', url: '', events: [], includeInternal: false });
const { busy, run: act } = useAction();
const newSecret = ref(null); // { name, secret }: shown once after creating
const openLog = ref(null); // webhook id whose deliveries are shown
const deliveries = ref([]);
const openPayload = ref(null);

async function load() {
  await attempt(async () => {
    const r = await get(props.base);
    hooks.value = r.webhooks;
    allEvents.value = r.events;
  });
}
watch(() => props.base, load, { immediate: true });

const host = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '');
const size = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

function edit(h) {
  editing.value = h ? h.id : 'new';
  Object.assign(form, {
    name: h?.name || '',
    url: h?.url || '',
    events: h ? [...h.events] : [...allEvents.value],
    includeInternal: h?.includeInternal || false,
  });
}

const save = () =>
  act(
    async () => {
      if (editing.value === 'new') {
        const r = await post(props.base, { ...form });
        newSecret.value = { name: r.webhook.name || host(r.webhook.url), secret: r.secret };
      } else {
        await patch(`/api/webhooks/${editing.value}`, { ...form });
      }
      editing.value = null;
      await load();
    },
    { ok: editing.value === 'new' ? 'Webhook added' : 'Webhook saved' },
  );

const setActive = (h, active) =>
  act(
    async () => {
      await patch(`/api/webhooks/${h.id}`, { active });
      await load();
    },
    { ok: active ? 'Webhook turned on' : 'Webhook turned off' },
  );

function remove(h) {
  if (!confirm(`Delete the webhook to ${host(h.url)}? Its delivery log is deleted too.`)) return;
  act(
    async () => {
      await del(`/api/webhooks/${h.id}`);
      if (openLog.value === h.id) openLog.value = null;
      await load();
    },
    { ok: 'Webhook deleted' },
  );
}

async function loadLog(id) {
  deliveries.value = (await get(`/api/webhooks/${id}/deliveries`)).deliveries;
}
const toggleLog = (h) =>
  act(async () => {
    openPayload.value = null;
    if (openLog.value === h.id) {
      openLog.value = null;
      return;
    }
    openLog.value = h.id;
    await loadLog(h.id);
  });

function result(d) {
  if (d.ok) return `Delivered (${d.statusCode})`;
  return d.error || `Failed${d.statusCode ? ` (${d.statusCode})` : ''}`;
}

const sendTest = (h) =>
  act(async () => {
    const r = await post(`/api/webhooks/${h.id}/test`);
    toast(r.delivery.ok ? `Test delivered (${r.delivery.status})` : `Test failed: ${r.delivery.error}`, r.delivery.ok ? 'ok' : 'error');
    await load();
    if (openLog.value === h.id) await loadLog(h.id);
  });

const redeliver = (h, d) =>
  act(async () => {
    const r = await post(`/api/webhooks/${h.id}/deliveries/${d.id}/redeliver`);
    toast(r.delivery.ok ? `Sent again (${r.delivery.status})` : `Failed again: ${r.delivery.error}`, r.delivery.ok ? 'ok' : 'error');
    await load();
    await loadLog(h.id);
  });

const copySecret = () => copyText(newSecret.value.secret, { ok: 'Secret copied' });
</script>

<template>
  <div class="card p-4">
    <div class="mb-2 flex flex-wrap items-center gap-2">
      <h2 class="text-sm font-semibold">Webhooks</h2>
      <button class="btn btn-sm btn-primary ml-auto" :disabled="busy" @click="edit(null)">Add webhook</button>
    </div>
    <p class="mb-2 text-xs text-slate-500">
      {{ intro || 'Send a signed JSON message to another system when something happens.' }}
      Each delivery has an <code>X-Tracker-Signature</code> header to check it came from here.
      <RouterLink to="/help#admin-webhooks" class="link">How to check it</RouterLink>
    </p>

    <div v-if="newSecret" class="mb-3 space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
      <p>
        <strong>Signing secret for {{ newSecret.name }}.</strong> Copy it now and store it in the receiving system. It is not shown again.
      </p>
      <code class="block break-all rounded bg-white p-2 font-mono text-xs">{{ newSecret.secret }}</code>
      <div class="flex gap-2">
        <button class="btn btn-sm" @click="copySecret">Copy</button><button class="btn btn-sm" @click="newSecret = null">Done</button>
      </div>
    </div>

    <div v-for="h in hooks" :key="h.id" class="border-b border-slate-100 py-2 text-sm">
      <div class="flex flex-wrap items-center gap-2">
        <span class="min-w-0 flex-1">
          <span class="font-semibold">{{ h.name || host(h.url) }}</span>
          <span v-if="!h.active" class="chip ml-1 bg-slate-100 text-slate-600">Off</span>
          <span v-else-if="h.failureCount" class="chip ml-1 bg-red-50 text-red-700">{{ h.failureCount }} failed in a row</span>
          <span class="block truncate text-xs text-slate-500">{{ h.url }}</span>
          <span class="block text-xs text-slate-500">
            {{ h.events.length }} {{ plural(h.events.length, 'event') }}<template v-if="h.includeInternal">, internal notes too</template>.
            Secret ends in <code>{{ h.secretLast4 }}</code>.
            <template v-if="h.lastDeliveryAt">
              Last delivery {{ when(h.lastDeliveryAt) }}<template v-if="h.lastStatus">, {{ h.lastStatus }}</template
              >.</template
            >
          </span>
          <span v-if="h.disabledReason" class="block text-xs text-red-700"
            >{{ h.disabledReason }}. Fix the receiver, then turn it on again.</span
          >
        </span>
        <div class="flex flex-wrap gap-1">
          <button class="btn btn-sm" :disabled="busy" @click="sendTest(h)">Send test</button>
          <button class="btn btn-sm" :disabled="busy" :aria-expanded="openLog === h.id" @click="toggleLog(h)">Deliveries</button>
          <button class="btn btn-sm" :disabled="busy" @click="setActive(h, !h.active)">{{ h.active ? 'Turn off' : 'Turn on' }}</button>
          <button class="btn btn-sm btn-ghost" :disabled="busy" @click="edit(h)">Edit</button>
          <button class="btn btn-sm btn-danger" :disabled="busy" @click="remove(h)">Delete</button>
        </div>
      </div>

      <div v-if="openLog === h.id" class="mt-2 rounded-md bg-slate-50 p-2">
        <p v-if="!deliveries.length" class="text-xs text-slate-500">No deliveries yet. Use Send test to try it.</p>
        <div v-else class="overflow-x-auto">
          <table class="w-full text-left text-xs">
            <thead>
              <tr class="text-slate-500">
                <th class="py-1 pr-2">When</th>
                <th class="py-1 pr-2">Event</th>
                <th class="py-1 pr-2">Result</th>
                <th class="py-1 pr-2">Time</th>
                <th class="py-1 pr-2">Size</th>
                <th class="py-1"></th>
              </tr>
            </thead>
            <tbody>
              <template v-for="d in deliveries" :key="d.id">
                <tr class="border-t border-slate-200 align-top">
                  <td class="whitespace-nowrap py-1 pr-2">{{ when(d.createdAt) }}</td>
                  <td class="py-1 pr-2 font-mono">
                    {{ d.event }}<span v-if="d.test" class="text-slate-500"> (test)</span
                    ><span v-if="d.redeliveryOf" class="text-slate-500"> (again)</span>
                  </td>
                  <td class="py-1 pr-2" :class="d.ok ? 'text-green-700' : 'text-red-700'">{{ result(d) }}</td>
                  <td class="whitespace-nowrap py-1 pr-2">{{ d.durationMs }} ms</td>
                  <td class="whitespace-nowrap py-1 pr-2">{{ size(d.payloadSize) }}</td>
                  <td class="whitespace-nowrap py-1">
                    <button class="link mr-2" @click="openPayload = openPayload === d.id ? null : d.id">Body</button>
                    <button v-if="d.event !== 'ping'" class="link" :disabled="busy" @click="redeliver(h, d)">Redeliver</button>
                  </td>
                </tr>
                <tr v-if="openPayload === d.id">
                  <td colspan="6" class="pb-2">
                    <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-white p-2 font-mono text-xs">{{
                      d.payload
                    }}</pre>
                    <p v-if="d.payloadCut" class="text-slate-500">Only the first 2 KB of the body is kept.</p>
                    <p class="text-slate-500">
                      X-Tracker-Delivery: <code>{{ d.id }}</code>
                    </p>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
          <p class="mt-1 text-xs text-slate-500">
            The last 50 deliveries are kept. Redeliver sends the event again with the issue as it is now, with a new delivery id.
          </p>
        </div>
      </div>

      <form v-if="editing === h.id" class="mt-2 space-y-3 rounded-md bg-slate-50 p-3" @submit.prevent="save">
        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <label class="label" :for="`wh-url-${h.id}`">URL</label
            ><input :id="`wh-url-${h.id}`" v-model="form.url" class="input" type="url" required maxlength="2000" placeholder="https://" />
          </div>
          <div>
            <label class="label" :for="`wh-name-${h.id}`">Name (optional)</label
            ><input :id="`wh-name-${h.id}`" v-model="form.name" class="input" maxlength="100" />
          </div>
        </div>
        <fieldset>
          <legend class="label">Send when</legend>
          <div class="grid gap-1 sm:grid-cols-2">
            <label v-for="e in allEvents" :key="e" class="flex items-center gap-2 text-sm"
              ><input v-model="form.events" type="checkbox" :value="e" /> {{ EVENT_LABELS[e] || e }}</label
            >
          </div>
        </fieldset>
        <label class="flex items-start gap-2 text-sm"
          ><input v-model="form.includeInternal" type="checkbox" class="mt-1" />
          <span>Also send internal notes (comments hidden from guests). Only for systems your team controls.</span></label
        >
        <div class="flex gap-2">
          <button class="btn btn-primary" :disabled="busy || !form.events.length">Save</button
          ><button type="button" class="btn" @click="editing = null">Cancel</button>
        </div>
      </form>
    </div>
    <p v-if="!hooks.length && editing !== 'new'" class="py-2 text-sm text-slate-500">No webhooks yet.</p>

    <form v-if="editing === 'new'" class="mt-3 space-y-3 rounded-md bg-slate-50 p-3" @submit.prevent="save">
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="label" for="wh-url-new">URL</label
          ><input id="wh-url-new" v-model="form.url" class="input" type="url" required maxlength="2000" placeholder="https://" />
        </div>
        <div>
          <label class="label" for="wh-name-new">Name (optional)</label
          ><input id="wh-name-new" v-model="form.name" class="input" maxlength="100" placeholder="e.g. Deploy bot" />
        </div>
      </div>
      <p class="text-xs text-slate-500">The URL must start with https:// and be a public address (not localhost or a private network).</p>
      <fieldset>
        <legend class="label">Send when</legend>
        <div class="grid gap-1 sm:grid-cols-2">
          <label v-for="e in allEvents" :key="e" class="flex items-center gap-2 text-sm"
            ><input v-model="form.events" type="checkbox" :value="e" /> {{ EVENT_LABELS[e] || e }}</label
          >
        </div>
      </fieldset>
      <label class="flex items-start gap-2 text-sm"
        ><input v-model="form.includeInternal" type="checkbox" class="mt-1" />
        <span>Also send internal notes (comments hidden from guests). Only for systems your team controls.</span></label
      >
      <div class="flex gap-2">
        <button class="btn btn-primary" :disabled="busy || !form.events.length">Add webhook</button
        ><button type="button" class="btn" @click="editing = null">Cancel</button>
      </div>
    </form>
  </div>
</template>
