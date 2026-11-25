<script setup>
// Help: Frequently asked questions
import { FAQ } from './faq.js';
</script>
<template>
  <div v-for="g in FAQ" :key="g.group" class="space-y-2">
    <h3 class="pt-2 text-xs font-bold uppercase tracking-wider text-slate-500">{{ g.group }}</h3>
    <details v-for="item in g.items" :key="item.q" class="group rounded-[15px] border border-slate-200 bg-white px-4 py-3 open:bg-slate-50">
      <summary class="flex cursor-pointer list-none items-start gap-2 font-medium marker:hidden">
        <span class="mt-0.5 text-accent transition-transform group-open:rotate-90">›</span><span>{{ item.q }}</span>
      </summary>
      <div class="mt-2 space-y-2 pl-4 text-slate-700">
        <p v-for="(para, i) in item.a" :key="i">{{ para }}</p>
      </div>
    </details>
  </div>
</template>
