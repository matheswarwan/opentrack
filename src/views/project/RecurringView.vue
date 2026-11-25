<script setup>
// Project > Recurring: the recurring rules for members (project admins also find them under Settings).
import { inject } from 'vue';
import ProjectRecurring from '../../components/ProjectRecurring.vue';
const project = inject('project');
</script>
<template>
  <ProjectRecurring :key="project.key" :project-key="project.key" class="max-w-5xl" />
</template>
