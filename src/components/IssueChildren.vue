<script setup>
// Issue page: the issues in an epic, or the sub-tasks of an issue, with progress and a quick add.
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { post } from '../api.js';
import { attempt } from '../composables/useAction.js';
import IssueRow from './IssueRow.vue';

const props = defineProps({ issue: { type: Object, required: true }, canCreate: Boolean });
const emit = defineEmits(['changed']); // a child was added
const router = useRouter();
const childTitle = ref('');

const childProgress = computed(() => {
  const kids = props.issue.children || [];
  if (!kids.length) return null;
  const done = kids.filter((k) => k.status.category === 'done').length;
  return { done, total: kids.length, pct: Math.round((done / kids.length) * 100) };
});
async function addChild() {
  if (!childTitle.value.trim()) return;
  const type = props.issue.type === 'epic' ? 'story' : 'subtask';
  await attempt(
    () =>
      post('/api/issues', {
        projectKey: props.issue.projectKey,
        type,
        title: childTitle.value,
        parentKey: props.issue.key,
        sprintId: type === 'subtask' ? props.issue.sprint?.id : null,
      }),
    {
      then: () => {
        childTitle.value = '';
        emit('changed');
      },
    },
  );
}
</script>
<template>
  <section class="mb-5">
    <div class="mb-1 flex items-center gap-2">
      <h2 class="text-sm font-semibold text-slate-700">{{ issue.type === 'epic' ? 'Issues in this epic' : 'Sub-tasks' }}</h2>
      <div v-if="childProgress" class="flex items-center gap-2 text-xs text-slate-500">
        <div class="h-1.5 w-24 rounded bg-slate-200">
          <div class="h-1.5 rounded bg-green-600" :style="{ width: childProgress.pct + '%' }"></div>
        </div>
        {{ childProgress.done }} of {{ childProgress.total }} done
      </div>
    </div>
    <div v-if="issue.children.length" class="card divide-y divide-slate-100">
      <IssueRow v-for="c in issue.children" :key="c.id" :issue="c" @open="router.push(`/browse/${c.key}`)" />
    </div>
    <form v-if="canCreate" class="mt-2 flex gap-2" @submit.prevent="addChild">
      <input
        v-model="childTitle"
        class="input"
        aria-label="New child issue title"
        :placeholder="issue.type === 'epic' ? 'Add a story to this epic' : 'Add a sub-task'"
      />
      <button class="btn" :disabled="!childTitle.trim()">Add</button>
    </form>
  </section>
</template>
