<script setup>
import { computed, ref, watch } from 'vue';
const props = defineProps({ user: Object, size: { type: Number, default: 24 }, label: { type: String, default: '' } });
// label: '' (circle only), 'short' (Jane D.), 'first' (Jane), 'full' (Jane Doe)
const text = computed(() => {
  if (!props.label) return '';
  if (!props.user) return 'Unassigned';
  const parts = (props.user.name || '').split(/\s+/).filter(Boolean);
  if (props.label === 'full' || parts.length < 2) return props.user.name;
  if (props.label === 'first') return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
});
// black or white initials, whichever reads better on the avatar colour (WCAG contrast)
function textOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#fff';
  const ch = [0, 2, 4]
    .map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const L = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  return (L + 0.05) / 0.05 > 1.05 / (L + 0.05) ? '#000' : '#fff';
}
const fg = computed(() => textOn(props.user?.avatarColor || '#64748b'));
const initials = computed(() => {
  const n = props.user?.name || '';
  return (
    n
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0].toUpperCase())
      .join('') || '?'
  );
});
// Photo when the user has one; initials if it fails to load.
const failed = ref(false);
watch(
  () => props.user?.avatarUrl,
  () => {
    failed.value = false;
  },
);
const photo = computed(() => (!failed.value && props.user?.avatarUrl) || '');
</script>
<template>
  <span v-if="label" class="inline-flex min-w-0 items-center gap-1.5" :title="user ? user.name : 'Unassigned'">
    <img
      v-if="user && photo"
      :src="photo"
      :alt="user.name"
      class="shrink-0 rounded-full object-cover"
      :style="{ width: size + 'px', height: size + 'px' }"
      @error="failed = true"
    />
    <span
      v-else-if="user"
      class="inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold"
      :style="{
        width: size + 'px',
        height: size + 'px',
        fontSize: size * 0.42 + 'px',
        background: user.avatarColor || '#64748b',
        color: fg,
      }"
      >{{ initials }}</span
    >
    <span
      v-else
      class="inline-flex shrink-0 items-center justify-center rounded-full border border-dashed border-slate-400 text-slate-400"
      :style="{ width: size + 'px', height: size + 'px', fontSize: size * 0.5 + 'px' }"
      >?</span
    >
    <span class="truncate" :class="user ? '' : 'text-slate-400'">{{ text }}</span>
  </span>
  <img
    v-else-if="user && photo"
    :src="photo"
    :alt="user.name"
    :title="user.name"
    class="inline-block shrink-0 rounded-full object-cover"
    :style="{ width: size + 'px', height: size + 'px' }"
    @error="failed = true"
  />
  <span
    v-else-if="user"
    class="inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold"
    :style="{ width: size + 'px', height: size + 'px', fontSize: size * 0.42 + 'px', background: user.avatarColor || '#64748b', color: fg }"
    :title="user.name"
    >{{ initials }}</span
  >
  <span
    v-else
    class="inline-flex shrink-0 items-center justify-center rounded-full border border-dashed border-slate-400 text-slate-400"
    :style="{ width: size + 'px', height: size + 'px', fontSize: size * 0.5 + 'px' }"
    title="Unassigned"
    >?</span
  >
</template>
