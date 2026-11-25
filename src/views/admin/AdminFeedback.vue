<script setup>
import { ref } from 'vue';
import { get, patch, toast } from '../../api.js';
import { openCreate } from '../../ui.js';
import { ago, fmtDateTime } from '../../meta.js';
import Avatar from '../../components/Avatar.vue';
import { attempt } from '../../composables/useAction.js';
import { useLoad } from '../../composables/useLoad.js';
import LoadState from '../../components/LoadState.vue';

const counts = ref({});
const status = ref('new');
const open = ref(null);
const note = ref('');
const {
  data: rows,
  loading,
  error: loadError,
  reload: load,
} = useLoad(
  async () => {
    const r = await get(`/api/admin/feedback${status.value ? `?status=${status.value}` : ''}`);
    counts.value = r.counts;
    return r.feedback;
  },
  null,
  { initial: [] },
);
async function setStatus(f, s) {
  await attempt(async () => {
    await patch(`/api/admin/feedback/${f.id}`, { status: s, note: note.value });
    toast(s === 'done' ? 'Marked done' : 'Saved');
    open.value = null;
    await load();
  });
}
async function view(f) {
  open.value = open.value?.id === f.id ? null : f;
  note.value = f.adminNote || '';
  if (open.value && f.status === 'new') {
    await patch(`/api/admin/feedback/${f.id}`, { status: 'seen' });
    f.status = 'seen';
  }
}
function toIssue(f) {
  const lines = [
    f.message,
    '',
    `_From feedback by ${f.user?.name || 'a former user'} on ${fmtDateTime(f.createdAt)}${f.page ? `, page ${f.page}` : ''}._`,
  ];
  openCreate({
    type: f.kind === 'bug' ? 'bug' : 'story',
    title: f.message.split('\n')[0].slice(0, 120),
    description: lines.join('\n'),
    stay: false,
  });
}
const kindCls = {
  bug: 'bg-red-100 text-red-800',
  idea: 'bg-violet-100 text-violet-800',
  question: 'bg-amber-100 text-amber-800',
  other: 'bg-slate-100 text-slate-700',
};
</script>
<template>
  <div class="mb-3 flex gap-2">
    <button
      v-for="s in [
        ['new', 'New'],
        ['seen', 'Seen'],
        ['done', 'Done'],
        ['', 'All'],
      ]"
      :key="s[0]"
      class="btn btn-sm"
      :class="status === s[0] ? 'btn-primary' : ''"
      @click="
        status = s[0];
        load();
      "
    >
      {{ s[1] }}<template v-if="s[0]"> ({{ counts[s[0]] || 0 }})</template>
    </button>
  </div>
  <LoadState v-if="loading || loadError" :loading="loading" :error="loadError" card @retry="load" />
  <div v-else class="card divide-y divide-slate-100">
    <p v-if="!rows.length" class="px-3 py-10 text-center text-sm text-slate-500">No feedback here.</p>
    <div v-for="f in rows" :key="f.id">
      <button class="flex w-full items-start gap-3 px-3 py-2.5 text-left text-sm hover:bg-slate-50" @click="view(f)">
        <Avatar :user="f.user" :size="26" />
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 text-xs text-slate-500">
            <strong class="text-sm font-medium text-slate-800">{{ f.user?.name || 'Former user' }}</strong><span
              class="chip capitalize"
              :class="kindCls[f.kind]"
              >{{ f.kind }}</span
            >{{ ago(f.createdAt) }}<span v-if="f.hasScreenshot">· screenshot</span
            ><span v-if="f.status === 'new'" class="ml-1 h-2 w-2 rounded-full bg-blue-600"></span>
          </div>
          <p class="mt-0.5" :class="open?.id === f.id ? 'whitespace-pre-wrap' : 'truncate'">{{ f.message }}</p>
        </div>
      </button>
      <div v-if="open?.id === f.id" class="space-y-3 bg-slate-50 px-3 py-3 pl-12 text-sm">
        <div class="text-xs text-slate-600">
          {{ f.user?.email }} · {{ fmtDateTime(f.createdAt)
          }}<template v-if="f.page">
            · page <RouterLink :to="f.page" class="link">{{ f.page }}</RouterLink></template
          >
        </div>
        <a v-if="f.hasScreenshot" :href="`/api/admin/feedback/${f.id}/screenshot`" target="_blank" rel="noopener"
          ><img
            :src="`/api/admin/feedback/${f.id}/screenshot`"
            alt="Screenshot sent with the feedback"
            class="max-h-80 rounded border border-slate-200"
        /></a>
        <pre v-if="f.details" class="whitespace-pre-wrap break-all rounded bg-white p-2 text-xs">{{
          JSON.stringify(f.details, null, 2)
        }}</pre>
        <div>
          <label class="label" for="fb-note">Reply note (the sender sees it under "Your earlier feedback")</label
          ><textarea id="fb-note" v-model="note" class="input" rows="2"></textarea>
        </div>
        <div class="flex gap-2">
          <button class="btn btn-primary btn-sm" @click="setStatus(f, 'done')">Mark done</button>
          <button class="btn btn-sm" @click="setStatus(f, f.status === 'done' ? 'seen' : f.status)">Save note</button>
          <button v-if="f.status === 'done'" class="btn btn-sm" @click="setStatus(f, 'seen')">Reopen</button>
          <button class="btn btn-sm ml-auto" @click="toIssue(f)">Create an issue from this</button>
        </div>
      </div>
    </div>
  </div>
</template>
