<script setup>
import { ref, computed } from 'vue';
import { put, del, session, toast, loadMe, users as refreshPicker } from '../api.js';
import Avatar from './Avatar.vue';
import { attempt } from '../composables/useAction.js';

const SIZE = 256;
const MAX_BYTES = 200 * 1024;
const pending = ref(''); // data URL waiting to be saved
const busy = ref(false);
const error = ref('');
const input = ref(null);
const shown = computed(() => (pending.value ? { ...session.user, avatarUrl: pending.value } : session.user));

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This file could not be read as an image. Use a JPEG, PNG or WebP file.'));
    };
    img.src = url;
  });
}

/** Crop the centre square, scale to 256x256 and encode as JPEG under 200 KB. */
async function toSquareJpeg(file) {
  const img = await loadImage(file);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; // transparent PNGs get a white background
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, SIZE, SIZE);
  for (const q of [0.88, 0.75, 0.6, 0.45]) {
    const data = canvas.toDataURL('image/jpeg', q);
    if ((data.length - data.indexOf(',') - 1) * 0.75 <= MAX_BYTES) return data;
  }
  throw new Error('The photo is too large after resizing');
}

async function pick(e) {
  error.value = '';
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    error.value = 'Choose an image file';
    return;
  }
  try {
    pending.value = await toSquareJpeg(file);
  } catch (err) {
    error.value = err.message;
  }
}

async function save() {
  busy.value = true;
  error.value = '';
  try {
    await put('/api/me/avatar', { image: pending.value });
    pending.value = '';
    await loadMe();
    refreshPicker(true);
    toast('Photo saved');
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function remove() {
  busy.value = true;
  await attempt(async () => {
    await del('/api/me/avatar');
    await loadMe();
    refreshPicker(true);
    toast('Photo removed');
  });
  busy.value = false;
}
</script>
<template>
  <div class="card space-y-3 p-4">
    <h2 class="text-sm font-semibold">Photo</h2>
    <div class="flex items-center gap-4">
      <Avatar :user="shown" :size="72" />
      <div class="space-y-2">
        <p class="text-sm text-slate-600">
          Shown next to your name instead of your initials. The centre of the image is cropped to a square.
        </p>
        <div class="flex flex-wrap gap-2">
          <input ref="input" type="file" accept="image/jpeg,image/png,image/webp" class="hidden" @change="pick" />
          <button type="button" class="btn" :disabled="busy" @click="input.click()">
            {{ session.user.avatarUrl || pending ? 'Choose another photo' : 'Choose a photo' }}
          </button>
          <template v-if="pending">
            <button type="button" class="btn btn-primary" :disabled="busy" @click="save">Save photo</button>
            <button type="button" class="btn" :disabled="busy" @click="pending = ''">Cancel</button>
          </template>
          <button v-else-if="session.user.avatarUrl" type="button" class="btn" :disabled="busy" @click="remove">Remove photo</button>
        </div>
        <p v-if="pending" class="text-xs text-slate-500">Preview. Not saved yet.</p>
        <p v-if="error" class="text-sm text-red-700">{{ error }}</p>
      </div>
    </div>
  </div>
</template>
