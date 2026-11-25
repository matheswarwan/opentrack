<script setup>
// "Attach files" for the Create issue form: files are picked now and uploaded once the issue exists.
// The parent calls uploadTo(issueKey) after creating the issue.
import { ref } from 'vue';
import { toast } from '../api.js';
import { uploadAttachment, fmtSize } from '../attachments.js';

const files = ref([]);
const busy = ref(false);
const input = ref(null);
function onPick(e) {
  files.value.push(...e.target.files);
  e.target.value = '';
}
async function uploadTo(issueKey) {
  if (!files.value.length) return;
  busy.value = true;
  let failed = 0;
  for (const f of files.value) {
    try {
      await uploadAttachment(issueKey, f);
    } catch (e) {
      failed++;
      toast(e.message, 'error');
    }
  }
  busy.value = false;
  files.value = [];
  if (failed) toast(`${issueKey} was created. Add the files that failed from the issue page.`, 'error');
}
defineExpose({ uploadTo });
</script>

<template>
  <div>
    <div class="flex items-center gap-2">
      <button type="button" class="btn btn-sm" :disabled="busy" @click="input.click()">Attach files</button>
      <span v-if="busy" class="text-xs text-slate-500">Uploading…</span>
      <input ref="input" type="file" multiple class="hidden" @change="onPick" />
    </div>
    <div v-for="(f, i) in files" :key="i + f.name" class="flex items-center gap-2 pt-1 text-sm">
      <span class="truncate">{{ f.name }}</span><span class="text-xs text-slate-500">{{ fmtSize(f.size) }}</span>
      <button
        type="button"
        class="text-slate-400 hover:text-red-700"
        :aria-label="`Remove ${f.name}`"
        :disabled="busy"
        @click="files.splice(i, 1)"
      >
        ×
      </button>
    </div>
  </div>
</template>
