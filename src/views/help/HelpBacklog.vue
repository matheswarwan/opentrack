<script setup>
// Help: Backlog and sprints
</script>
<template>
  <p>
    The backlog lists every open issue not yet in a sprint, above it any planned sprints and the active one. Drag issues to reorder them or
    move them into a sprint.
  </p>
  <ol class="list-decimal space-y-1 pl-5">
    <li><strong>Create sprint</strong> adds an empty sprint. Drag in the issues you plan to do.</li>
    <li><strong>Start sprint</strong> sets the dates and a goal. A project has one active sprint at a time.</li>
    <li><strong>Complete sprint</strong> closes it and moves unfinished issues to the backlog or the next sprint.</li>
  </ol>
  <p>Each sprint shows its issue count, story points and how many are to do, in progress and done.</p>
</template>
