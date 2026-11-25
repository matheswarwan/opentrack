<script setup>
// Help: Creating issues
</script>
<template>
  <ul class="list-disc space-y-1 pl-5">
    <li><strong>+ Create</strong> (or <kbd>c</kbd>): the full form. Tick <em>Create another</em> to add several in a row.</li>
    <li>On the board, the <strong>+</strong> next to a column name adds an issue straight into that column.</li>
    <li>In the backlog, <strong>+ Create issue</strong> under a sprint or the backlog adds it there.</li>
    <li>On an issue, the box under Sub-tasks adds a sub-task; on an epic it adds a story to the epic.</li>
    <li>
      From Slack, when Slack is connected: paste a message link in the Create issue form to copy the message and its thread into the issue.
    </li>
    <li>From an AI assistant: ask Claude or another connected assistant to create the issue for you (see AI assistants below).</li>
  </ul>
  <p>
    Descriptions and comments use Markdown: <code>**bold**</code>, <code>- lists</code>, <code>`code`</code>, links. Typing an issue key
    such as WEB-12 links to it.
  </p>
</template>
