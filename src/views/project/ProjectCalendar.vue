<script setup>
// Project > Calendar: this project's issues by due date, with its sprints.
import { inject } from 'vue';
import Calendar from '../../components/Calendar.vue';
const project = inject('project');
</script>
<template>
  <Calendar :project-key="project.key" :project="project" />
</template>
