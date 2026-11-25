<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import { post, get } from '../api.js';
import { ago } from '../meta.js';
import Modal from './Modal.vue';
import { recentErrors, recentFailedRequests } from '../diagnostics.js';

const emit = defineEmits(['close']);
const route = useRoute();
const kind = ref('bug');
const message = ref('');
const includeDetails = ref(true);
const screenshot = ref(null);
const busy = ref(false);
const error = ref('');
const sent = ref(false);
const mine = ref(null);
const showDetails = ref(false);

const KINDS = [
  { id: 'bug', label: 'Something is wrong' },
  { id: 'idea', label: 'Idea' },
  { id: 'question', label: 'Question' },
  { id: 'other', label: 'Other' },
];
const details = computed(() => ({
  page: route.fullPath,
  version: __APP_VERSION__,
  browser: navigator.userAgent,
  screen: `${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}x`,
  language: navigator.language,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  online: navigator.onLine,
  recentErrors: recentErrors.slice(),
  recentFailedRequests: recentFailedRequests.slice(),
}));
const capturing = ref(false);

// Picture of the page behind the dialog (the dialog itself is left out).
async function capturePage() {
  capturing.value = true;
  error.value = '';
  try {
    const { domToJpeg } = await import('modern-screenshot');
    const root = document.getElementById('app-shell') || document.body;
    const scale = Math.min(1, 1600 / root.scrollWidth);
    const url = await domToJpeg(root, {
      quality: 0.8,
      scale,
      width: root.scrollWidth,
      height: Math.min(root.scrollHeight, 2400),
      backgroundColor: '#ffffff',
      filter: (node) => !(node instanceof Element && node.closest && node.closest('[data-no-capture]')),
    });
    screenshot.value = url.length < 1_400_000 ? url : await shrink(url);
  } catch (e) {
    error.value = `Could not capture the page (${e.message}). Attach a screenshot instead.`;
  } finally {
    capturing.value = false;
  }
}
async function shrink(url) {
  const blob = await (await fetch(url)).blob();
  return toDataUrl(blob);
}

// Shrink an image to at most 1600 px wide, JPEG, so it fits the upload limit.
async function toDataUrl(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / bmp.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  for (const q of [0.85, 0.7, 0.5]) {
    const url = canvas.toDataURL('image/jpeg', q);
    if (url.length < 1_400_000) return url;
  }
  throw new Error('That image is too large');
}
async function useFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  try {
    screenshot.value = await toDataUrl(file);
    error.value = '';
  } catch (e) {
    error.value = e.message;
  }
}
function onPaste(e) {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) {
    e.preventDefault();
    useFile(item.getAsFile());
  }
}
onMounted(() => window.addEventListener('paste', onPaste));
onBeforeUnmount(() => window.removeEventListener('paste', onPaste));

async function send() {
  busy.value = true;
  error.value = '';
  try {
    await post('/api/feedback', {
      kind: kind.value,
      message: message.value,
      page: route.fullPath,
      details: includeDetails.value ? details.value : null,
      screenshot: screenshot.value,
    });
    sent.value = true;
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
async function loadMine() {
  sent.value = false;
  mine.value = (await get('/api/feedback/mine')).feedback;
}
const statusLabel = { new: 'Received', seen: 'Seen by an admin', done: 'Done' };
</script>

<template>
  <Modal title="Send feedback" @close="emit('close')">
    <div v-if="sent" class="py-4 text-center">
      <div class="text-3xl">✓</div>
      <p class="mt-2 font-medium">Thank you. Your feedback reached the admins.</p>
      <p class="mt-1 text-sm text-slate-600">You can see what happens to it under "Your earlier feedback".</p>
    </div>
    <form v-else-if="!mine" id="feedback-form" class="space-y-3" @submit.prevent="send">
      <div class="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Type">
        <button
          v-for="k in KINDS"
          :key="k.id"
          type="button"
          role="radio"
          :aria-checked="kind === k.id"
          class="rounded-full border px-3 py-1 text-sm"
          :class="
            kind === k.id ? 'border-blue-700 bg-blue-50 font-medium text-blue-800' : 'border-slate-300 text-slate-600 hover:bg-slate-50'
          "
          @click="kind = k.id"
        >
          {{ k.label }}
        </button>
      </div>
      <div>
        <label class="label" for="fb-message">{{
          kind === 'bug' ? 'What happened, and what did you expect?' : kind === 'idea' ? 'What would make this better?' : 'Your message'
        }}</label>
        <textarea id="fb-message" v-model="message" class="input" rows="5" maxlength="10000" required autofocus></textarea>
      </div>
      <div>
        <div v-if="screenshot" class="relative inline-block">
          <img :src="screenshot" alt="Attached screenshot" class="max-h-40 rounded border border-slate-200" />
          <button
            type="button"
            class="absolute right-1 top-1 rounded bg-white/90 px-1.5 text-sm shadow"
            aria-label="Remove screenshot"
            @click="screenshot = null"
          >
            ×
          </button>
        </div>
        <div v-else class="flex flex-wrap gap-2">
          <button type="button" class="btn" :disabled="capturing" @click="capturePage">
            {{ capturing ? 'Capturing…' : 'Capture this page' }}
          </button>
          <label
            class="flex flex-1 cursor-pointer items-center gap-2 rounded-md border border-dashed border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
          >
            <input type="file" accept="image/*" class="sr-only" @change="useFile($event.target.files[0])" />
            or attach an image (paste works too)
          </label>
        </div>
      </div>
      <div class="text-sm">
        <label class="flex items-center gap-2"
          ><input v-model="includeDetails" type="checkbox" /> Include technical details (page, app version, browser, screen size, recent
          errors)</label
        >
        <button v-if="includeDetails" type="button" class="link ml-6 text-xs" @click="showDetails = !showDetails">
          {{ showDetails ? 'Hide' : 'Show' }} what is sent
        </button>
        <pre
          v-if="includeDetails && showDetails"
          class="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded bg-slate-100 p-2 text-xs"
          >{{ JSON.stringify(details, null, 2) }}</pre>
      </div>
      <p class="text-xs text-slate-500">Your name and email are sent with it so an admin can follow up.</p>
      <p v-if="error" class="text-sm text-red-700">{{ error }}</p>
    </form>
    <div v-else>
      <p v-if="!mine.length" class="py-6 text-center text-sm text-slate-500">You have not sent any feedback yet.</p>
      <div v-for="f in mine" :key="f.id" class="border-b border-slate-100 py-2 text-sm">
        <div class="flex items-center gap-2 text-xs text-slate-500">
          <span class="capitalize">{{ f.kind }}</span> · {{ ago(f.createdAt) }}
          <span
            class="chip ml-auto"
            :class="
              f.status === 'done'
                ? 'bg-green-100 text-green-800'
                : f.status === 'seen'
                  ? 'bg-blue-100 text-blue-800'
                  : 'bg-slate-100 text-slate-600'
            "
            >{{ statusLabel[f.status] }}</span
          >
        </div>
        <p class="mt-0.5 whitespace-pre-wrap">{{ f.message }}</p>
        <p v-if="f.adminNote" class="mt-1 rounded bg-slate-50 px-2 py-1 text-xs text-slate-700">
          <strong>Admin:</strong> {{ f.adminNote }}
        </p>
      </div>
    </div>
    <template #footer>
      <button v-if="!mine && !sent" type="button" class="link mr-auto text-sm" @click="loadMine">Your earlier feedback</button>
      <button
        v-if="mine"
        type="button"
        class="link mr-auto text-sm"
        @click="
          mine = null;
          sent = false;
          message = '';
          screenshot = null;
        "
      >
        Send new feedback
      </button>
      <template v-if="sent">
        <button class="btn mr-auto" @click="loadMine">Your earlier feedback</button>
        <button class="btn btn-primary" @click="emit('close')">Close</button>
      </template>
      <template v-else-if="!mine">
        <button class="btn" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" form="feedback-form" :disabled="busy || !message.trim()">Send</button>
      </template>
      <button v-else class="btn" @click="emit('close')">Close</button>
    </template>
  </Modal>
</template>
