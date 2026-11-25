<script setup>
// Print page of a status report (/projects/:key/status/:id/print): workspace fonts, black and the accent colour, no app chrome.
// The browser prints it or saves it as PDF (Print > Save as PDF). Guests get the same page for shared reports.
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { get, session } from '../../api.js';
import { RAG, RAG_AREAS, periodText, ragLabel, reportMarkdown, day } from '../../statusReport.js';
import Markdown from '../../components/Markdown.vue';

const route = useRoute();
const report = ref(null);
const project = ref(null);
const error = ref('');
onMounted(async () => {
  try {
    const r = await get(`/api/projects/${route.params.key}/status-reports/${route.params.id}`);
    report.value = r.report;
    project.value = r.project;
    document.title = `Status report ${r.project.key} ${r.report.periodEnd}`;
  } catch (e) {
    error.value = e.message;
  }
});
const body = computed(() => (report.value ? reportMarkdown(report.value, project.value, { head: false }) : ''));
const printPage = () => window.print();
const areas = computed(() => RAG_AREAS.filter((a) => report.value?.rag?.[a.id]));
</script>

<template>
  <div class="status-print mx-auto max-w-3xl bg-white px-4 py-6 text-black sm:px-8">
    <p v-if="error" class="py-16 text-center text-slate-600">{{ error }}</p>
    <template v-else-if="report">
      <div class="mb-4 flex flex-wrap items-center gap-2 print:hidden">
        <RouterLink :to="`/projects/${route.params.key}/status/${report.id}`" class="link text-sm">Back to the report</RouterLink>
        <button class="btn btn-sm btn-primary ml-auto" @click="printPage">Print or save as PDF</button>
      </div>
      <header class="flex items-start justify-between gap-4 border-b-4 border-accent pb-3">
        <div>
          <p class="text-xs font-bold uppercase tracking-[0.08em] text-slate-600">Status report</p>
          <h1 class="text-2xl font-bold">{{ project.name }}</h1>
          <p class="text-sm">
            {{ periodText(report) }}<template v-if="report.publishedAt">. Published {{ day(report.publishedAt.slice(0, 10)) }}</template
            ><template v-else>. Draft</template><template v-if="report.author">. {{ report.author.name }}</template>
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-2 font-display font-semibold">
          <img src="/logo-mark.svg" alt="" class="h-8 w-8" />{{ session.appName }}
        </div>
      </header>
      <table class="mt-4 w-full border-collapse text-left text-sm">
        <caption class="sr-only">
          RAG status
        </caption>
        <thead>
          <tr class="border-b border-black">
            <th scope="col" class="py-1.5 pr-3">Area</th>
            <th scope="col" class="py-1.5 pr-3">Status</th>
            <th scope="col" class="py-1.5">Notes</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in areas" :key="a.id" class="border-b border-slate-200 align-top">
            <th scope="row" class="py-1.5 pr-3 font-semibold">{{ a.label }}</th>
            <td class="py-1.5 pr-3">
              <span class="chip border" :class="RAG[report.rag[a.id].value]?.cls">{{ ragLabel(report.rag[a.id].value) }}</span>
            </td>
            <td class="py-1.5">{{ report.rag[a.id].reason || (report.rag[a.id].why || []).join('; ') }}</td>
          </tr>
        </tbody>
      </table>
      <div class="mt-4"><Markdown :text="body" /></div>
      <footer class="mt-8 border-t border-slate-200 pt-2 text-xs text-slate-600">
        {{ session.appName }}. {{ project.key }} status report, {{ periodText(report) }}.
      </footer>
    </template>
  </div>
</template>

<style>
@media print {
  @page {
    margin: 16mm;
  }
  .status-print {
    max-width: none;
    padding: 0;
  }
  .status-print .chip {
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .status-print a {
    color: #000;
    text-decoration: none;
  }
}
.status-print,
.status-print h1,
.status-print h2 {
  font-family: var(--font-sans);
}
.status-print .md h2 {
  border-bottom: 2px solid #1d7a46;
  padding-bottom: 2px;
  font-size: 1.05rem;
}
</style>
