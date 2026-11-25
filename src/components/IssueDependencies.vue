<script setup>
// Epic page > Dependencies: 'blocks' links touching its issues, blockers first (a simple ordering, no graph).
import { computed } from 'vue';
import StatusBadge from './StatusBadge.vue';

const props = defineProps({ issue: { type: Object, required: true } });

const dependencyList = computed(() => {
  const deps = props.issue.dependencies || [];
  const order = new Map((props.issue.children || []).map((c, i) => [c.key, i]));
  const depth = new Map();
  const depthOf = (key, seen = new Set()) => {
    if (depth.has(key)) return depth.get(key);
    if (seen.has(key)) return 0; // a loop: stop counting
    seen.add(key);
    const parents = deps.filter((d) => d.to.key === key && d.from.key).map((d) => depthOf(d.from.key, seen) + 1);
    const n = parents.length ? Math.max(...parents) : 0;
    depth.set(key, n);
    return n;
  };
  const rank = (d) => (d.from.key ? depthOf(d.from.key) : -1);
  return [...deps].sort((a, b) => rank(a) - rank(b) || (order.get(a.from.key) ?? 999) - (order.get(b.from.key) ?? 999));
});
</script>
<template>
  <section class="mb-5">
    <h2 class="mb-1 text-sm font-semibold text-slate-700">Dependencies</h2>
    <ol v-if="dependencyList.length" class="card divide-y divide-slate-100 text-sm">
      <li v-for="(d, n) in dependencyList" :key="n" class="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5">
        <template v-for="(end, side) in { from: d.from, to: d.to }" :key="side">
          <span v-if="side === 'to'" class="text-xs text-slate-500" aria-label="blocks">→ blocks →</span>
          <span v-if="end.hidden" class="text-slate-500">an issue you cannot see</span>
          <span v-else class="flex min-w-0 items-center gap-1.5">
            <RouterLink :to="`/browse/${end.key}`" class="link" :class="end.status.category === 'done' ? 'line-through' : ''">{{
              end.key
            }}</RouterLink>
            <span class="max-w-[12rem] truncate" :class="end.child ? '' : 'text-slate-500'">{{ end.title }}</span>
            <StatusBadge :status="end.status" />
          </span>
        </template>
      </li>
    </ol>
    <p v-else class="text-sm text-slate-400">
      No issue in this epic blocks or is blocked by another. Add "blocks" links to plan the order.
    </p>
  </section>
</template>
