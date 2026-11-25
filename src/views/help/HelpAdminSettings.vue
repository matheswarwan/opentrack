<script setup>
// Help: Workspace settings, Google and Slack
</script>
<template>
  <p><RouterLink to="/admin/settings" class="link">Admin &gt; Settings</RouterLink>:</p>
  <ul class="list-disc space-y-1 pl-5">
    <li>App name, and whether members may create projects or only admins.</li>
    <li>
      <strong>Google sign-in</strong> works once the server has a Google client ID and secret. Choose the allowed domains (for example
      example.com), whether people from those domains get an account on first sign-in, and whether password sign-in stays on.
    </li>
    <li>
      <strong>Security</strong>: the <em>allowed email domains</em> for new accounts (adding, inviting, importing and first Google sign-in
      refuse other addresses; existing people are not affected), an <em>idle timeout</em> that signs out sessions nobody has used for the
      set time, and <em>require two-factor sign-in for admins</em> (an admin without it can only open Profile until it is on).
    </li>
    <li><strong>AI assistants</strong>: turning off API tokens stops every token and connected app at once.</li>
  </ul>
  <p>
    <RouterLink to="/admin/slack" class="link">Admin &gt; Slack</RouterLink> connects a Slack workspace with a bot token. The page lists the
    steps and the permissions the Slack app needs, and shows recent Slack errors (for example a channel the bot was not invited to).
  </p>
</template>
