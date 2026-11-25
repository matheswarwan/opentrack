<script setup>
// Textarea with @mention autocomplete. People see "@Name" while typing; the value given to the
// parent (and stored) uses the @[Name](user:id) token so mentions survive renames and notify the right person.
import { ref, computed, onMounted, nextTick, watch } from 'vue';
import { users as loadUsers } from '../api.js';
import Avatar from './Avatar.vue';
import Markdown from './Markdown.vue';
import { uploadAttachment, attachmentMarkdown, namePasted } from '../attachments.js';
import { attempt } from '../composables/useAction.js';

// issueKey: when set, pasting a file uploads it to that issue and inserts a Markdown link or image.
// internal: the text is an internal note, so pasted files are internal too (hidden from guests).
const props = defineProps({
  modelValue: String,
  rows: { type: Number, default: 5 },
  placeholder: String,
  autofocus: Boolean,
  issueKey: String,
  internal: Boolean,
});
const emit = defineEmits(['update:modelValue', 'submit', 'uploaded']);
const ta = ref(null);
const people = ref([]);
const mention = ref(null); // { start, query }
const active = ref(0);
const preview = ref(false);
const known = new Map(); // display name -> user id for mentions in this text
const TOKEN_RE = /@\[([^\]]{1,100})\]\(user:([0-9a-f-]{36})\)/g;
const toDisplay = (v) =>
  String(v || '').replace(TOKEN_RE, (_, name, id) => {
    known.set(name, id);
    return `@${name}`;
  });
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function toTokens(display) {
  let out = display;
  for (const name of [...known.keys()].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`(^|[^\\w\\]])@${esc(name)}(?![\\w])`, 'g'), (_, pre) => `${pre}@[${name}](user:${known.get(name)})`);
  }
  return out;
}
const text = ref(toDisplay(props.modelValue));
let lastEmitted = props.modelValue || '';
watch(
  () => props.modelValue,
  (v) => {
    if ((v || '') !== lastEmitted) {
      text.value = toDisplay(v);
      lastEmitted = v || '';
    }
  },
);
function emitValue(display) {
  text.value = display;
  lastEmitted = toTokens(display);
  emit('update:modelValue', lastEmitted);
}
onMounted(async () => {
  people.value = await loadUsers();
  if (props.autofocus) {
    await nextTick();
    ta.value?.focus();
  }
});
const matches = computed(() => {
  if (!mention.value) return [];
  const q = mention.value.query.toLowerCase();
  return people.value.filter((u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().startsWith(q)).slice(0, 6);
});
function onInput(e) {
  emitValue(e.target.value);
  const pos = e.target.selectionStart;
  const before = e.target.value.slice(0, pos);
  const m = before.match(/(^|\s)@([\w.\- ]{0,30})$/);
  if (m && !/\s{2}/.test(m[2])) {
    mention.value = { start: pos - m[2].length - 1, query: m[2] };
    active.value = 0;
  } else mention.value = null;
}
async function pick(u) {
  const v = text.value || '';
  const end = ta.value.selectionStart;
  known.set(u.name, u.id);
  const ins = `@${u.name} `;
  emitValue(v.slice(0, mention.value.start) + ins + v.slice(end));
  const caret = mention.value.start + ins.length;
  mention.value = null;
  await nextTick();
  ta.value.focus();
  ta.value.setSelectionRange(caret, caret);
}
function onKey(e) {
  if (mention.value && matches.value.length) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      active.value = (active.value + 1) % matches.value.length;
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      active.value = (active.value - 1 + matches.value.length) % matches.value.length;
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      pick(matches.value[active.value]);
      return;
    }
    if (e.key === 'Escape') {
      mention.value = null;
      return;
    }
  }
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    emit('submit');
  }
}
const pasting = ref(0);
async function onPaste(e) {
  const files = [...(e.clipboardData?.files || [])];
  if (!props.issueKey || !files.length) return;
  e.preventDefault();
  const pos = e.target.selectionStart;
  pasting.value++;
  try {
    const out = [];
    for (const f of files) {
      await attempt(async () => {
        out.push(attachmentMarkdown(await uploadAttachment(props.issueKey, namePasted(f), null, { internal: props.internal })));
      });
    }
    if (!out.length) return;
    const v = text.value || '';
    const ins = out.join('\n');
    emitValue(v.slice(0, pos) + ins + v.slice(pos));
    emit('uploaded');
    await nextTick();
    ta.value?.focus();
    ta.value?.setSelectionRange(pos + ins.length, pos + ins.length);
  } finally {
    pasting.value--;
  }
}
function onBlur() {
  setTimeout(() => (mention.value = null), 150);
}
defineExpose({ focus: () => ta.value?.focus() });
</script>
<template>
  <div class="relative">
    <div class="mb-1 flex gap-2 text-xs">
      <button type="button" :class="!preview ? 'font-semibold text-slate-800' : 'text-slate-500'" @click="preview = false">Write</button>
      <button type="button" :class="preview ? 'font-semibold text-slate-800' : 'text-slate-500'" @click="preview = true">Preview</button>
      <span v-if="pasting" class="text-slate-500">Uploading pasted file…</span>
      <span class="ml-auto text-slate-400">Markdown, @ to mention, Ctrl+Enter to save</span>
    </div>
    <div v-if="preview" class="min-h-[6rem] rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
      <Markdown :text="modelValue" />
      <p v-if="!modelValue" class="text-sm text-slate-400">Nothing to preview</p>
    </div>
    <textarea
      v-else
      ref="ta"
      class="input font-[inherit]"
      :rows="rows"
      :value="text"
      :placeholder="placeholder"
      @input="onInput"
      @keydown="onKey"
      @blur="onBlur"
      @paste="onPaste"
    ></textarea>
    <div v-if="mention && matches.length" class="absolute left-2 z-40 mt-1 w-64 rounded-md border border-slate-200 bg-white py-1 shadow-lg">
      <button
        v-for="(u, i) in matches"
        :key="u.id"
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm"
        :class="i === active ? 'bg-blue-50' : 'hover:bg-slate-100'"
        @mousedown.prevent="pick(u)"
      >
        <Avatar :user="u" :size="20" />{{ u.name }}
      </button>
    </div>
  </div>
</template>
