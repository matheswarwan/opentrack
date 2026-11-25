<script setup>
// Project > Issues: the issue search inside this project.
import { inject } from 'vue';
import IssueSearch from '../../components/IssueSearch.vue';

const project = inject('project');
</script>
<template>
  <IssueSearch :project="project" />
</template>
