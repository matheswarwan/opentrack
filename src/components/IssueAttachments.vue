<script setup>
// Attachments section of an issue: thumbnails for pictures, rows for other files,
// Add attachment button. IssueDetail also calls upload() for files dropped on the issue.
import { ref, reactive, computed } from 'vue';
import ImageViewer from './ImageViewer.vue';
import { del } from '../api.js';
import { uploadAttachment, isImage, fmtSize } from '../attachments.js';
import { ago, fmtDateTime } from '../meta.js';
import { attempt } from '../composables/useAction.js';

const props = defineProps({
  issueKey: String,
  attachments: { type: Array, default: () => [] },
  canEdit: Boolean,
  canAdmin: Boolean,
  guest: Boolean,
}); // guest: cannot delete files
const emit = defineEmits(['changed']);
const input = ref(null);
const uploads = ref([]); // { id, name, pct }
const images = computed(() => props.attachments.filter(isImage));
const files = computed(() => props.attachments.filter((a) => !isImage(a)));
const viewing = ref(-1);

async function upload(list) {
  const picked = [...list];
  if (!picked.length || !props.canEdit) return;
  let done = 0;
  await Promise.all(
    picked.map(async (file) => {
      const u = reactive({ id: Math.random(), name: file.name, pct: 0 });
      uploads.value.push(u);
      await attempt(async () => {
        await uploadAttachment(props.issueKey, file, (p) => (u.pct = Math.round(p * 100)));
        done++;
      });
      uploads.value = uploads.value.filter((x) => x.id !== u.id);
    }),
  );
  if (done) emit('changed');
}
function onPick(e) {
  upload(e.target.files);
  e.target.value = '';
}
async function remove(a) {
  if (!confirm(`Delete ${a.filename}?`)) return;
  await attempt(async () => {
    await del(`/api/attachments/${a.id}`);
    emit('changed');
  });
}
const canDelete = (a) => props.canAdmin || (props.canEdit && a.mine && !props.guest);
defineExpose({ upload, pick: () => input.value?.click() });
</script>

<template>
  <section class="mb-5">
    <div class="mb-1 flex items-center gap-2">
      <h2 class="text-sm font-semibold text-slate-700">
        Attachments<span v-if="attachments.length" class="font-normal text-slate-500"> ({{ attachments.length }})</span>
      </h2>
      <button v-if="canEdit" class="link text-xs" @click="input.click()">Add attachment</button>
      <input ref="input" type="file" multiple class="hidden" @change="onPick" />
    </div>
    <div v-for="u in uploads" :key="u.id" class="flex items-center gap-2 py-1 text-sm text-slate-600">
      <span class="h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700"></span>
      <span class="truncate">Uploading {{ u.name }}</span
      ><span class="text-xs text-slate-500">{{ u.pct }}%</span>
    </div>
    <div v-if="images.length" class="mb-2 grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2">
      <div v-for="a in images" :key="a.id" class="group relative overflow-hidden rounded-md border border-slate-200 bg-slate-50">
        <button
          type="button"
          class="block w-full text-left"
          @click="viewing = images.indexOf(a)"
          :title="`${a.filename}, ${fmtSize(a.size)}, added by ${a.uploadedBy?.name || 'former user'} ${fmtDateTime(a.createdAt)}`"
        >
          <img :src="a.url" :alt="a.filename" loading="lazy" class="h-24 w-full object-cover" />
          <div class="truncate px-1.5 py-0.5 text-xs text-slate-600">
            <span v-if="a.internal" class="chip mr-1 bg-amber-100 text-amber-900">Internal</span>{{ a.filename }}
          </div>
        </button>
        <button
          v-if="canDelete(a)"
          class="absolute right-1 top-1 hidden rounded-full bg-white px-1.5 text-sm text-slate-600 shadow hover:text-red-700 group-hover:block"
          :aria-label="`Delete ${a.filename}`"
          @click="remove(a)"
        >
          ×
        </button>
      </div>
    </div>
    <div v-for="a in files" :key="a.id" class="flex items-center gap-2 py-1 text-sm">
      <span v-if="a.internal" class="chip shrink-0 bg-amber-100 text-amber-900" title="Added with an internal note; guests cannot see it"
        >Internal</span
      >
      <a :href="a.url" class="link truncate" :download="a.filename">{{ a.filename }}</a>
      <span class="shrink-0 text-xs text-slate-500">{{ fmtSize(a.size) }}</span>
      <span class="shrink-0 truncate text-xs text-slate-400" :title="fmtDateTime(a.createdAt)"
        >{{ a.uploadedBy?.name || 'Former user' }}, {{ ago(a.createdAt) }}</span
      >
      <button v-if="canDelete(a)" class="ml-auto text-slate-400 hover:text-red-700" :aria-label="`Delete ${a.filename}`" @click="remove(a)">
        ×
      </button>
    </div>
    <ImageViewer v-if="viewing >= 0 && images[viewing]" v-model:index="viewing" :images="images" @close="viewing = -1" />
    <p v-if="!attachments.length && !uploads.length" class="text-sm text-slate-400">
      {{ canEdit ? 'None. Drop files on the issue or paste an image into the description or a comment.' : 'None' }}
    </p>
  </section>
</template>
