<script setup>
// The running timer as a small pill: issue key, elapsed time, Stop and Discard. `dark` styles it for the black phone bar.
import { computed } from 'vue';
import { timerState, elapsedMs, clockText, minutesText, minutesOf, askStop, discardTimer } from '../timer.js';
import Icon from './Icon.vue';

defineProps({ dark: Boolean });
const ms = computed(() => elapsedMs());
const spoken = computed(() => minutesText(minutesOf(ms.value)));
</script>
<template>
  <div
    v-if="timerState.timer"
    class="flex min-w-0 items-center gap-1 rounded-full border py-0.5 pl-2.5 pr-1 text-sm"
    :class="dark ? 'border-white/40 text-white' : 'border-slate-300 bg-white text-black'"
    role="group"
    aria-label="Running timer"
  >
    <RouterLink
      :to="`/browse/${timerState.timer.issueKey}`"
      class="flex min-w-0 items-center gap-1.5 hover:underline"
      :title="`Timer running on ${timerState.timer.issueKey}: ${timerState.timer.title}`"
    >
      <Icon name="clock" :size="15" />
      <span class="truncate font-semibold">{{ timerState.timer.issueKey }}</span>
      <span class="tabular-nums" aria-hidden="true">{{ clockText(ms) }}</span>
      <span class="sr-only">running for {{ spoken }}</span>
    </RouterLink>
    <button
      class="ml-1 rounded-full px-2.5 py-0.5 text-xs font-bold"
      :class="dark ? 'bg-white text-black hover:bg-slate-200' : 'bg-black text-white hover:bg-slate-800'"
      :disabled="timerState.busy"
      @click="askStop"
    >
      Stop<span class="sr-only"> timer and log the time</span>
    </button>
    <button
      class="rounded-full px-2 py-0.5 text-xs font-medium"
      :class="dark ? 'text-white hover:bg-white/15' : 'text-slate-700 hover:bg-slate-100'"
      :disabled="timerState.busy"
      @click="discardTimer"
    >
      Discard<span class="sr-only"> timer</span>
    </button>
  </div>
</template>
