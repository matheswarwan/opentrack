<script setup>
// Project > Roadmap: this project's epics on a timeline.
import { inject } from 'vue';
import Roadmap from '../../components/Roadmap.vue';
const project = inject('project');
</script>
<template>
  <Roadmap :project-key="project.key" />
</template>
