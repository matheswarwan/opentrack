<script setup>
import { computed } from 'vue';
import { typeOf } from '../meta.js';
const props = defineProps({ type: String, size: { type: Number, default: 16 } });
const t = computed(() => typeOf(props.type));
</script>
<template>
  <span
    class="inline-flex shrink-0 items-center justify-center rounded-[3px] font-bold text-white"
    :style="{ width: size + 'px', height: size + 'px', fontSize: size * 0.62 + 'px', background: t.color }"
    :title="t.label"
    >{{ t.glyph }}</span
  >
</template>
