<script setup>
// Google Sheets feed: turn the current issue search into a secret CSV link for =IMPORTDATA(...),
// and list or revoke your feeds.
import { ref, computed } from 'vue';
import { get, post, del, toast } from '../api.js';
import { copyText } from '../browser.js';
import { ago } from '../meta.js';
import Modal from './Modal.vue';
import { attempt } from '../composables/useAction.js';
import { useLoad } from '../composables/useLoad.js';
import LoadState from '../components/LoadState.vue';

const props = defineProps({ query: { type: Object, required: true } });
defineEmits(['close']);

const name = ref('Project plan');
const picked = ref([]);
const created = ref(null); // { url, formula } shown once
const busy = ref(false);

const {
  data: info,
  loading,
  error: loadError,
  reload: load,
} = useLoad(async () => {
  // one project in the search: its custom fields are offered as columns too
  const one = props.query.project && !String(props.query.project).includes(',') ? String(props.query.project) : '';
  const r = await get(`/api/feeds${one ? `?project=${encodeURIComponent(one)}` : ''}`);
  if (!picked.value.length) picked.value = [...r.defaultColumns];
  return r;
});

const LABELS = {
  q: 'Text',
  project: 'Project',
  type: 'Type',
  category: 'Status',
  priority: 'Priority',
  assignee: 'Assignee',
  reporter: 'Reporter',
  label: 'Label',
  sprint: 'Sprint',
  component: 'Component',
  fixVersion: 'Fix version',
  sort: 'Sort',
  dir: 'Order',
};
// custom field filters (cf.<id>, cf.<id>.empty) by the field's name
function cfText(k, v) {
  const m = /^cf\.([^.]+)(\.empty)?$/.exec(k);
  const name = info.value?.columns.find((c) => c.id === `cf:${m[1]}`)?.label || 'Custom field';
  if (m[2]) return `${name}: ${v === '1' ? 'no value' : 'has a value'}`;
  return `${name}: ${v}`;
}
const summary = computed(() => {
  const parts = Object.entries(props.query)
    .filter(([k]) => k !== 'sort' && k !== 'dir')
    .map(([k, v]) => (k.startsWith('cf.') ? cfText(k, v) : `${LABELS[k] || k}: ${v === 'me' ? 'me (the feed owner)' : v}`));
  return parts.length ? parts.join(', ') : 'All issues you can see';
});
const describe = (q) =>
  Object.entries(q || {})
    .filter(([k]) => k !== 'sort' && k !== 'dir')
    .map(([k, v]) => `${LABELS[k] || k}: ${v}`)
    .join(', ') || 'All issues';

async function create() {
  busy.value = true;
  await attempt(async () => {
    // keep the column order of the list, not the click order
    const columns = info.value.columns.map((c) => c.id).filter((id) => picked.value.includes(id));
    created.value = await post('/api/feeds', { name: name.value, query: props.query, columns });
    await load();
  });
  busy.value = false;
}
async function revoke(f) {
  if (!confirm(`Revoke the feed "${f.name}"? Sheets that use it stop updating.`)) return;
  await attempt(async () => {
    await del(`/api/feeds/${f.id}`);
    await load();
    toast('Feed revoked');
  });
}
const copy = (text) => copyText(text);
</script>

<template>
  <Modal title="Google Sheets feed" wide @close="$emit('close')">
    <LoadState v-if="!info" :loading="loading" :error="loadError" @retry="load" />
    <div v-else class="space-y-4 text-sm">
      <p v-if="!info.enabled" class="rounded-md bg-slate-100 p-2 text-slate-700">
        An admin has turned Google Sheets feeds off. Existing feeds do not work until it is on again.
      </p>

      <template v-else-if="created">
        <p>Your feed is ready. Paste this formula into cell A1 of an empty sheet in Google Sheets:</p>
        <div class="flex gap-2">
          <input :value="created.formula" class="input font-mono text-xs" readonly @focus="$event.target.select()" /><button
            class="btn"
            @click="copy(created.formula)"
          >
            Copy
          </button>
        </div>
        <p class="text-xs text-slate-500">
          This is the only time the link is shown. If you lose it, create a new feed and revoke this one.
        </p>
        <ul class="list-disc space-y-1 pl-5 text-slate-600">
          <li>
            Google Sheets refreshes the data about every hour. Use other tabs for your own notes and formulas, since the feed rewrites its
            range.
          </li>
          <li>Anyone with the link can read this data, so keep the link and the sheet private.</li>
          <li>The feed shows what you can see now. If you lose access to a project, its issues drop out.</li>
          <li>Revoke the feed below at any time. At most {{ info.maxRows.toLocaleString() }} rows.</li>
        </ul>
        <button class="btn" @click="created = null">Create another feed</button>
      </template>

      <form v-else class="space-y-3" @submit.prevent="create">
        <p class="text-slate-600">
          Creates a secret link to a CSV of the current search that Google Sheets can pull with <code>=IMPORTDATA(...)</code>.
        </p>
        <div>
          <span class="label">Search</span>
          <div class="text-slate-700">{{ summary }}</div>
        </div>
        <div>
          <label class="label" for="sf-name">Feed name</label><input id="sf-name" v-model="name" class="input" required maxlength="100" />
        </div>
        <fieldset>
          <legend class="label">Columns</legend>
          <div class="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
            <label v-for="c in info.columns" :key="c.id" class="flex items-center gap-2"
              ><input v-model="picked" type="checkbox" :value="c.id" /> {{ c.label }}</label
            >
          </div>
        </fieldset>
        <button class="btn btn-primary" :disabled="busy || !picked.length">Create feed</button>
      </form>

      <div>
        <h3 class="label">Your feeds</h3>
        <p v-if="!info.feeds.length" class="text-xs text-slate-500">None yet.</p>
        <div v-for="f in info.feeds" :key="f.id" class="flex items-center gap-2 border-t border-slate-100 py-1.5">
          <div class="min-w-0 flex-1">
            <div class="font-medium">
              {{ f.name }} <span class="font-mono text-xs text-slate-400">{{ f.prefix }}...</span>
            </div>
            <div class="truncate text-xs text-slate-500">
              {{ describe(f.query) }} · {{ f.columns.length }} columns · created {{ ago(f.createdAt) }} ·
              {{ f.lastUsedAt ? `last used ${ago(f.lastUsedAt)}` : 'never used' }}
            </div>
          </div>
          <button class="btn btn-sm btn-danger" @click="revoke(f)">Revoke</button>
        </div>
      </div>
    </div>
    <template #footer><button class="btn btn-primary" @click="$emit('close')">Done</button></template>
  </Modal>
</template>
