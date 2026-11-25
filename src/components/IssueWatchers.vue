<script setup>
// Issue page > Watchers: who follows the issue, remove one, add one (the Watch button for yourself is in the page header).
import { ref } from 'vue';
import { post, del, session } from '../api.js';
import { attempt } from '../composables/useAction.js';
import Avatar from './Avatar.vue';
import UserSelect from './UserSelect.vue';

const props = defineProps({ issue: { type: Object, required: true }, canEdit: Boolean, canAdd: Boolean });
const emit = defineEmits(['changed']); // a watcher was added or removed
const addingWatcher = ref(false);

async function addWatcher(userId) {
  addingWatcher.value = false;
  if (!userId) return;
  await attempt(() => post(`/api/issues/${props.issue.key}/watchers`, { userId }), {
    ok: (r) => (r.added ? 'Watcher added. They were notified.' : ''),
    then: () => emit('changed'),
  });
}
async function removeWatcher(w) {
  await attempt(() => del(`/api/issues/${props.issue.key}/watchers/${w.id}`), { then: () => emit('changed') });
}
</script>
<template>
  <div class="min-w-0 space-y-1.5">
    <div v-for="w in issue.watchers" :key="w.id" class="group flex items-center gap-1.5">
      <Avatar :user="w" :size="22" label="full" class="min-w-0 flex-1" />
      <button
        v-if="canEdit || w.id === session.user.id"
        class="rounded-full px-1.5 text-slate-400 opacity-60 hover:bg-slate-100 hover:text-red-700 group-hover:opacity-100"
        :aria-label="`Remove ${w.name} from watchers`"
        :title="w.id === session.user.id ? 'Stop watching' : 'Remove watcher'"
        @click="removeWatcher(w)"
      >
        ×
      </button>
    </div>
    <p v-if="!issue.watchers.length" class="text-slate-400">Nobody yet</p>
    <div v-if="canAdd">
      <UserSelect
        v-if="addingWatcher"
        compact
        start-open
        :allow-none="false"
        placeholder="Choose a person"
        :model-value="null"
        @update:model-value="addWatcher"
      />
      <button v-else class="link text-xs" @click="addingWatcher = true">+ Add watcher</button>
    </div>
  </div>
</template>
