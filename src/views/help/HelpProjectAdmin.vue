<script setup>
// Help: Running a project
</script>
<template>
  <p>Open the project and choose <strong>Settings</strong> (only project admins and admins see it).</p>
  <ul class="list-disc space-y-1 pl-5">
    <li>
      <strong>Details</strong>: name, description, lead, and who can see it (everyone, or members only). <em>Archive project</em> hides it
      and makes it read only; you can restore it.
    </li>
    <li>
      <strong>Workflow</strong>: the board columns. Rename, reorder, add (for example QA) or delete them; deleting one asks where its issues
      go. Each column has a category (to do, in progress, done) that decides what counts as finished, and an optional limit on how many
      issues it should hold.
    </li>
    <li>
      <strong>Members</strong>: add people as project admin, member or viewer. This matters most for members-only projects. Guests (clients)
      get a guest level instead: read only, can comment, or can create and edit own.
    </li>
    <li>
      <strong>Workflow rules</strong>: limit which statuses an issue can move to (admins can be allowed to move issues anywhere), ask for
      values before an issue enters a status (assignee, story points, due date, estimate, fix version, components, a resolution comment or a
      custom field), and change the issue when it enters a status (assignee, labels, a custom field, a comment, the sprint, a message to
      watchers). The rules apply on the board, the status select, bulk changes and AI connectors.
    </li>
    <li>
      <strong>Permissions</strong>: who can delete issues, manage sprints (create, start, complete, move issues between sprints), create
      issues and comment.
    </li>
    <li><strong>Slack</strong>: when Slack is connected, pick the channel for this project's updates and which events post there.</li>
    <li>
      <strong>Webhooks</strong>: send this project's events to another system. See <a href="#admin-webhooks" class="link">Webhooks</a>.
    </li>
  </ul>
</template>
