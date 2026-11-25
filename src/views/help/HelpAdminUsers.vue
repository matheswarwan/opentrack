<script setup>
// Help: Adding and managing people
</script>
<template>
  <p><RouterLink to="/admin/users" class="link">Admin &gt; Users</RouterLink> lists everyone with their role, status and last sign-in.</p>
  <ul class="list-disc space-y-1 pl-5">
    <li>
      <strong>Add user</strong>: email, name and role. Either create an invite link (valid 7 days, works once) and send it to them, or set a
      password yourself so the account works at once. The app does not send email yet.
    </li>
    <li>
      <strong>Import from CSV</strong>: one person per line (email, name, role, title). Everyone gets an invite link; download them all as a
      CSV.
    </li>
    <li><strong>Role</strong>: change it in the list. There must always be at least one active admin.</li>
    <li><strong>Reset link</strong> or <strong>Set password</strong> when someone is locked out. Old links stop working.</li>
    <li>
      <strong>Sign out everywhere</strong> ends all of a person's browser sessions. <strong>Reset two-factor</strong> (shown when they have
      it on) turns their two-factor sign-in off and signs them out, for someone who lost their phone and recovery codes. Check who is asking
      first. Both are in the audit log.
    </li>
    <li>People whose email is outside the allowed domains are marked <em>Outside allowed domains</em>. Their accounts keep working.</li>
    <li>
      <strong>Deactivate</strong> signs the person out at once, stops their tokens and connected apps, and blocks sign-in. Their issues and
      comments stay. <strong>Reactivate</strong> undoes it.
    </li>
  </ul>
</template>
