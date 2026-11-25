<script setup>
// Issue page > Linked issues: the list, Add link and remove.
import { ref } from 'vue';
import { post, del } from '../api.js';
import { LINK_TYPES } from '../meta.js';
import { attempt } from '../composables/useAction.js';
import StatusBadge from './StatusBadge.vue';

const props = defineProps({ issue: { type: Object, required: true }, canEdit: Boolean });
const emit = defineEmits(['changed']); // a link was added or removed
const linkForm = ref(null);

async function addLink() {
  await attempt(() => post(`/api/issues/${props.issue.key}/links`, linkForm.value), {
    then: () => {
      linkForm.value = null;
      emit('changed');
    },
  });
}
async function removeLink(l) {
  await attempt(() => del(`/api/links/${l.id}`), { then: () => emit('changed') });
}
const linkLabel = (l) => {
  const t = LINK_TYPES.find((x) => x.id === l.type);
  return t ? t[l.direction] : l.type;
};
</script>
<template>
  <section class="mb-5">
    <div class="mb-1 flex items-center gap-2">
      <h2 class="text-sm font-semibold text-slate-700">Linked issues</h2>
      <button v-if="canEdit && !linkForm" class="link text-xs" @click="linkForm = { type: 'relates', targetKey: '' }">Add link</button>
    </div>
    <form v-if="linkForm" class="mb-2 flex gap-2" @submit.prevent="addLink">
      <select v-model="linkForm.type" class="input w-40" aria-label="Link type">
        <option v-for="t in LINK_TYPES" :key="t.id" :value="t.id">{{ t.out }}</option>
      </select>
      <input
        v-model="linkForm.targetKey"
        class="input w-40 uppercase"
        aria-label="Issue to link"
        placeholder="KEY-123"
        required
        autofocus
      />
      <button class="btn btn-primary">Link</button><button type="button" class="btn" @click="linkForm = null">Cancel</button>
    </form>
    <div v-for="l in issue.links" :key="l.id" class="flex items-center gap-2 py-1 text-sm">
      <span class="w-32 shrink-0 text-slate-500">{{ linkLabel(l) }}</span>
      <RouterLink :to="`/browse/${l.issue.key}`" class="link">{{ l.issue.key }}</RouterLink>
      <span class="truncate">{{ l.issue.title }}</span>
      <StatusBadge :status="l.issue.status" />
      <button v-if="canEdit" class="ml-auto text-slate-400 hover:text-red-700" aria-label="Remove link" @click="removeLink(l)">×</button>
    </div>
    <p v-if="!issue.links.length && !linkForm" class="text-sm text-slate-400">None</p>
  </section>
</template>
