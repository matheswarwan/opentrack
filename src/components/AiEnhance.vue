<script setup>
// "Enhance with AI" for a draft ticket (Chrome built-in AI). Emits `apply` with the improved fields.
import { ref, onMounted } from 'vue';
import { aiState, aiProgress, checkAi, enhanceTicket } from '../ai.js';
import { toast } from '../api.js';
import Markdown from './Markdown.vue';

const props = defineProps({ title: String, description: String, type: String, projectName: String });
const emit = defineEmits(['apply']);
const busy = ref(false);
const result = ref(null);
onMounted(() => {
  if (aiState.value === 'checking') checkAi();
});
async function run() {
  if (!props.title?.trim() && !props.description?.trim()) return toast('Write a summary or a few notes first', 'error');
  busy.value = true;
  try {
    result.value = await enhanceTicket(props);
  } catch (e) {
    toast(`AI could not finish: ${e.message}`, 'error');
  } finally {
    busy.value = false;
    if (aiState.value === 'downloading') checkAi();
  }
}
function apply() {
  emit('apply', result.value);
  result.value = null;
}
</script>
<template>
  <div v-if="aiState !== 'unavailable' && aiState !== 'checking'" class="text-sm">
    <button
      type="button"
      class="btn btn-sm"
      :disabled="busy"
      title="Rewrites the summary and description on this device with Chrome's built-in AI. Nothing is sent to a server."
      @click="run"
    >
      <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" />
      </svg>
      {{ busy ? (aiState === 'downloading' ? `Downloading the AI model… ${aiProgress}%` : 'Working…') : 'Enhance with AI' }}
    </button>
    <div v-if="result" class="mt-2 space-y-2 rounded-md border border-violet-200 bg-violet-50 p-3">
      <div class="text-xs font-semibold uppercase text-violet-800">Suggested</div>
      <div class="font-medium">{{ result.title }}</div>
      <div class="text-xs text-slate-600">
        Type: {{ result.type }} · Priority: {{ result.priority
        }}<template v-if="result.labels.length"> · Labels: {{ result.labels.join(', ') }}</template>
      </div>
      <div class="max-h-64 overflow-y-auto rounded bg-white px-3 py-2"><Markdown :text="result.description" /></div>
      <div class="flex gap-2">
        <button type="button" class="btn btn-primary btn-sm" @click="apply">Use this</button
        ><button type="button" class="btn btn-sm" @click="result = null">Discard</button>
      </div>
      <p class="text-xs text-slate-500">Made on this device by Chrome's built-in AI. Check it before saving.</p>
    </div>
  </div>
</template>
