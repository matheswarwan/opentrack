<script setup>
import { useRoute } from 'vue-router';
import IssueDetail from '../components/IssueDetail.vue';
const route = useRoute();
</script>
<template>
  <div class="mx-auto max-w-6xl"><IssueDetail :issue-key="String(route.params.key)" /></div>
</template>
