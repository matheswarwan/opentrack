<script setup>
// Help: Feedback and the audit log
</script>
<template>
  <p>
    <RouterLink to="/admin/feedback" class="link">Admin &gt; Feedback</RouterLink> collects what people send with the Feedback button, with
    screenshots and technical details when they chose to include them. Opening one marks it seen; add a reply note (the sender sees it),
    mark it done, or turn it into an issue.
  </p>
  <p>
    <RouterLink to="/admin/audit" class="link">Admin &gt; Audit log</RouterLink> records who added, changed or deactivated people, changed
    settings, created projects, deleted, restored or removed issues for good, downloaded backups, and created or revoked tokens.
  </p>
  <p>
    <RouterLink to="/admin/backups" class="link">Admin &gt; Backups</RouterLink> downloads a full backup of the workspace as one JSON file
    (optionally with attached files) and shows the automatic daily copy, if the server has a destination for it, and the backup to GitHub.
  </p>
  <p>
    <strong>Deleting a project</strong> (admins): Project settings &gt; Delete project, after typing the project key. It goes to the Trash
    with everything in it, hidden from everyone; an admin can restore it there or delete it forever. After the Trash period it is removed
    for good.
  </p>
</template>
