<script setup>
// Admin > Settings > Fonts: heading and body font stacks (part of the settings form, saved
// with it) and font files uploaded for those families. Uploads and removals apply at once. The settings form is a
// v-model (v-model:settings): a change hands the parent a new settings object, it is never edited in place.
import { ref, computed, onMounted } from 'vue';
import { get, post, del, toast } from '../api.js';
import { FONT_PRESETS, applyFonts } from '../brand.js';
import { attempt } from '../composables/useAction.js';

const settings = defineModel('settings', { type: Object, required: true });
const field = (key) => computed({ get: () => settings.value[key], set: (v) => (settings.value = { ...settings.value, [key]: v }) });
const fontHeading = field('fontHeading');
const fontBody = field('fontBody');
const faces = ref([]);
const busy = ref(false);
const form = ref({ family: '', weight: 400, style: 'normal' });
const fileInput = ref(null);

const preset = computed(() => FONT_PRESETS.find((p) => p.heading === fontHeading.value && p.body === fontBody.value)?.id || 'custom');
function pick(id) {
  const p = FONT_PRESETS.find((x) => x.id === id);
  if (!p) return;
  settings.value = { ...settings.value, fontHeading: p.heading, fontBody: p.body };
}
/** The first family of a stack, without quotes: the name an uploaded file is usually for. */
const firstFamily = (stack) =>
  String(stack || '')
    .split(',')[0]
    .trim()
    .replace(/^["']|["']$/g, '');
const wanted = computed(() => [...new Set([firstFamily(fontHeading.value), firstFamily(fontBody.value)].filter(Boolean))]);
const missing = computed(() => wanted.value.filter((f) => !faces.value.some((x) => x.family.toLowerCase() === f.toLowerCase())));

const load = () =>
  attempt(async () => {
    faces.value = (await get('/api/admin/fonts')).faces;
  });
onMounted(load);

function readFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Could not read the file'));
    r.readAsDataURL(file);
  });
}
async function upload(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  if (!form.value.family.trim()) form.value.family = wanted.value[0] || file.name.replace(/\.[^.]+$/, '');
  busy.value = true;
  await attempt(async () => {
    const r = await post('/api/admin/fonts', { ...form.value, family: form.value.family.trim(), file: await readFile(file) });
    faces.value = r.faces;
    applyFonts(r);
    toast(`${form.value.family} ${form.value.weight}${form.value.style === 'italic' ? ' italic' : ''} uploaded`);
  });
  busy.value = false;
}
async function remove(f) {
  await attempt(async () => {
    const r = await del(`/api/admin/fonts/${f.id}`);
    faces.value = r.faces;
    applyFonts(r);
  });
}
const kb = (n) => `${Math.round(n / 1024)} KB`;
</script>
<template>
  <div class="card space-y-3 p-4">
    <h2 class="text-sm font-semibold">Fonts</h2>
    <p class="text-xs text-slate-600">
      A font shows only if it is installed on the viewer's computer or uploaded below. Upload only fonts the workspace is licensed to use on
      the web. Others fall back along the list (for example to Helvetica or Arial).
    </p>
    <div>
      <label class="label" for="f-preset">Preset</label>
      <select id="f-preset" class="input" :value="preset" @change="pick($event.target.value)">
        <option v-for="p in FONT_PRESETS" :key="p.id" :value="p.id">{{ p.label }}</option>
        <option value="custom" disabled>Custom</option>
      </select>
    </div>
    <div>
      <label class="label" for="f-heading">Headings (CSS font list, empty for the default)</label
      ><input
        id="f-heading"
        v-model="fontHeading"
        class="input font-mono text-xs"
        maxlength="300"
        placeholder='"Inter", system-ui, sans-serif'
      />
    </div>
    <div>
      <label class="label" for="f-body">Everything else</label
      ><input id="f-body" v-model="fontBody" class="input font-mono text-xs" maxlength="300" placeholder='"Inter", system-ui, sans-serif' />
    </div>
    <div class="rounded-lg border border-slate-200 p-3" aria-label="Font preview">
      <div class="text-xl font-semibold" :style="{ fontFamily: fontHeading || 'var(--font-display)' }">Capacity planning</div>
      <p class="text-sm" :style="{ fontFamily: fontBody || 'var(--font-sans)' }">The quick brown fox jumps over the lazy dog. 0123456789</p>
      <p class="mt-1 text-xs text-slate-500">Preview before saving. Save settings to use it everywhere.</p>
    </div>

    <h3 class="label">Font files</h3>
    <p v-if="missing.length" class="text-xs text-amber-900">
      No file uploaded for {{ missing.join(', ') }}: it shows only where it is installed.
    </p>
    <ul v-if="faces.length" class="divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
      <li v-for="f in faces" :key="f.id" class="flex items-center gap-2 px-3 py-1.5">
        <span class="font-medium" :style="{ fontFamily: `'${f.family}'`, fontWeight: f.weight, fontStyle: f.style }">{{ f.family }}</span>
        <span class="text-xs text-slate-600">{{ f.weight }} {{ f.style }} · {{ f.format.toUpperCase() }} · {{ kb(f.size) }}</span>
        <button
          type="button"
          class="ml-auto text-xs text-red-800 hover:underline"
          :aria-label="`Remove ${f.family} ${f.weight} ${f.style}`"
          @click="remove(f)"
        >
          Remove
        </button>
      </li>
    </ul>
    <div class="flex flex-wrap items-end gap-2">
      <div>
        <label class="label" for="f-family">Family</label
        ><input id="f-family" v-model="form.family" class="input w-56" maxlength="80" :placeholder="wanted[0] || 'Family name'" />
      </div>
      <div>
        <label class="label" for="f-weight">Weight</label
        ><select id="f-weight" v-model.number="form.weight" class="input w-24">
          <option v-for="w in [100, 200, 300, 400, 500, 600, 700, 800, 900]" :key="w" :value="w">{{ w }}</option>
        </select>
      </div>
      <div>
        <label class="label" for="f-style">Style</label
        ><select id="f-style" v-model="form.style" class="input w-28">
          <option value="normal">Normal</option>
          <option value="italic">Italic</option>
        </select>
      </div>
      <input ref="fileInput" type="file" class="sr-only" accept=".woff2,.woff,.ttf,.otf" aria-label="Font file" @change="upload" />
      <button type="button" class="btn" :disabled="busy" @click="fileInput.click()">{{ busy ? 'Uploading' : 'Upload font file' }}</button>
    </div>
    <p class="text-xs text-slate-600">
      WOFF2, WOFF, TTF or OTF, up to 750 KB each, 12 files. The family name must match the name in the lists above.
    </p>
  </div>
</template>
