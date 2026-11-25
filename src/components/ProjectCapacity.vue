<script setup>
// Project settings > Capacity (project admins): the share of each member's time this project gets.
import { ref, watch } from 'vue';
import { get, put, toast } from '../api.js';
import { attempt } from '../composables/useAction.js';

const props = defineProps({ projectKey: { type: String, required: true } });
const members = ref([]);
const values = ref({});
const base = () => `/api/projects/${props.projectKey}/capacity`;

async function load() {
  await attempt(async () => {
    members.value = (await get(base())).members;
    values.value = Object.fromEntries(members.value.map((m) => [m.userId, m.pct === null ? '' : m.pct]));
  });
}
watch(() => props.projectKey, load, { immediate: true });

async function save() {
  await attempt(async () => {
    await put(base(), {
      allocations: members.value.map((m) => ({
        userId: m.userId,
        pct: values.value[m.userId] === '' || values.value[m.userId] === null ? null : Number(values.value[m.userId]),
      })),
    });
    toast('Allocations saved');
    await load();
  });
}
const hint = (m) =>
  m.pct !== null
    ? ''
    : m.projects > 1
      ? `Not allocated: counts as ${m.share}%, an even share of what other projects leave`
      : 'Not allocated: counts as 100% (only project)';
</script>

<template>
  <section class="card space-y-3 p-4" aria-labelledby="pcap-title">
    <div>
      <h2 id="pcap-title" class="text-sm font-semibold">Capacity</h2>
      <p class="text-xs text-slate-600">
        The share of each member's weekly hours that goes to this project, used on the Capacity page and the sprint hint in the backlog.
        Leave it empty for no allocation: a person in one project then counts fully, and someone in several projects shares out what their
        other allocations leave. Guests have no allocation.
      </p>
    </div>
    <form v-if="members.length" class="space-y-1" @submit.prevent="save">
      <div v-for="m in members" :key="m.userId" class="flex flex-wrap items-center gap-2 border-b border-slate-100 py-1.5 text-sm">
        <label :for="`pcap-${m.userId}`" class="min-w-0 flex-1 truncate"
          >{{ m.name }}<span class="sr-only"> allocation in percent</span></label
        >
        <span class="text-xs text-slate-600" :id="`pcap-h-${m.userId}`"
          >{{ hint(m) }}<template v-if="m.allocatedElsewhere"> ({{ m.allocatedElsewhere }}% allocated elsewhere)</template></span
        >
        <span class="flex items-center gap-1">
          <input
            :id="`pcap-${m.userId}`"
            v-model="values[m.userId]"
            type="number"
            min="0"
            max="100"
            step="5"
            class="input w-20 py-1"
            :aria-describedby="`pcap-h-${m.userId}`"
          />
          <span aria-hidden="true">%</span>
        </span>
      </div>
      <button class="btn btn-primary mt-2">Save allocations</button>
    </form>
    <p v-else class="text-sm text-slate-600">No members to allocate yet.</p>
  </section>
</template>
