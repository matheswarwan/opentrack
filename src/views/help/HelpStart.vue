<script setup>
// Help: Getting started
import { session } from '../../api.js';
</script>
<template>
  <p>
    {{ session.appName }} is where your team plans and tracks work: projects hold issues, issues move across a board from To Do to Done, and
    teams plan the next weeks in sprints.
  </p>
  <ol class="list-decimal space-y-1 pl-5">
    <li>
      Open <RouterLink to="/projects" class="link">Projects</RouterLink> and pick yours. Each project has a short key, such as WEB, and its
      issues are numbered WEB-1, WEB-2 and so on.
    </li>
    <li>
      Use the <strong>Board</strong> to see what is in progress, the <strong>Backlog</strong> to plan, and <strong>Issues</strong> to
      search.
    </li>
    <li>Press <kbd>c</kbd> anywhere, or the <strong>+ Create</strong> button, to add an issue.</li>
    <li>Check <RouterLink to="/" class="link">My work</RouterLink> each morning: it lists what is assigned to you and what is due soon.</li>
  </ol>
</template>
