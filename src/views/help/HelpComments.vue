<script setup>
// Help: Comments, status updates and mentions
</script>
<template>
  <p>
    Use comments for questions, decisions and status updates, so the history stays with the issue. Type <kbd>@</kbd> and a name to mention
    someone; they get a notification (and a Slack message, if Slack is connected). Everyone watching the issue is told about new comments.
  </p>
  <p>You can edit or delete your own comments. Project admins can delete any comment in their project.</p>
  <p>
    <strong>Reply</strong> starts a thread under a comment. The comment's author and everyone who replied before get a notification. A reply
    to an internal note is internal too. Deleting a comment that has replies keeps the replies and shows <em>Comment deleted</em> in its
    place.
  </p>
  <p>Use <strong>+</strong> under a comment to add a reaction; hover a reaction to see who added it. Reactions send no notifications.</p>
  <p>
    Tick <strong>Internal note</strong> before posting when a client should not read it. Internal notes and files pasted into them have an
    Internal badge and are never shown to guests.
  </p>
  <p>
    Deleting an issue (yours, unless the project allows only its admins to delete, or any issue in a project you admin) moves it and its
    sub-tasks to the <RouterLink to="/trash" class="link">Trash</RouterLink>. Restore it from there within 30 days; after that it is removed
    for good. Project admins can also delete it for good straight away.
  </p>
</template>
