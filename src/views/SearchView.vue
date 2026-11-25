<script setup>
// Issues page (/issues): the issue search over every project.
import IssueSearch from '../components/IssueSearch.vue';
</script>
<template>
  <IssueSearch>
    <template #heading><h1 class="mb-3 text-xl font-semibold">Issues</h1></template>
  </IssueSearch>
</template>
