<script setup>
// Reactions under a comment: pills with counts (hover lists who reacted), and a picker with the fixed set.
// A toggle shows the server's new counts here at once; a reloaded comment from the parent replaces them.
import { ref, watch } from 'vue';
import { post, del } from '../api.js';
import { attempt } from '../composables/useAction.js';

const props = defineProps({ comment: Object, canReact: Boolean });
const EMOJI = { thumbsup: '👍', check: '✅', eyes: '👀', heart: '❤️', laugh: '😄', party: '🎉' };
const LABEL = { thumbsup: 'Thumbs up', check: 'Done', eyes: 'Looking', heart: 'Heart', laugh: 'Laugh', party: 'Party' };
const picking = ref(false);
const busy = ref(false);
const reactions = ref([]);
watch(
  () => props.comment?.reactions,
  (r) => (reactions.value = r || []),
  { immediate: true },
);

async function toggle(reaction) {
  if (!props.canReact || busy.value) return;
  picking.value = false;
  const mine = reactions.value.find((r) => r.reaction === reaction)?.mine;
  busy.value = true;
  await attempt(async () => {
    const path = `/api/comments/${props.comment.id}/reactions/${reaction}`;
    const r = mine ? await del(path) : await post(path, {});
    reactions.value = r.reactions;
  });
  busy.value = false;
}
const who = (r) => r.users.map((u) => u.name).join(', ');
</script>

<template>
  <div v-if="reactions.length || canReact" class="mt-1 flex flex-wrap items-center gap-1">
    <button
      v-for="r in reactions"
      :key="r.reaction"
      type="button"
      class="flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
      :class="r.mine ? 'border-blue-600 bg-blue-50 text-blue-900' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'"
      :title="who(r)"
      :aria-label="`${LABEL[r.reaction]}: ${who(r)}`"
      :aria-pressed="r.mine"
      :disabled="!canReact"
      @click="toggle(r.reaction)"
    >
      <span aria-hidden="true">{{ EMOJI[r.reaction] }}</span>{{ r.count }}
    </button>
    <div v-if="canReact" class="relative">
      <button
        type="button"
        class="rounded-full border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-500 hover:bg-slate-50"
        aria-label="Add a reaction"
        :aria-expanded="picking"
        @click="picking = !picking"
      >
        +
      </button>
      <div v-if="picking" class="fixed inset-0 z-10" @click="picking = false"></div>
      <div
        v-if="picking"
        class="absolute left-0 z-20 mt-1 flex gap-0.5 rounded-md border border-slate-200 bg-white p-1 shadow"
        @keydown.esc="picking = false"
      >
        <button
          v-for="(e, id) in EMOJI"
          :key="id"
          type="button"
          class="rounded px-1.5 py-0.5 text-base hover:bg-slate-100"
          :title="LABEL[id]"
          :aria-label="LABEL[id]"
          @click="toggle(id)"
        >
          {{ e }}
        </button>
      </div>
    </div>
  </div>
</template>
