<script setup>
// Help: Slack
</script>
<template>
  <p>
    When an admin connects Slack, projects can post updates to a Slack channel (new issues, status changes, comments, sprints), and you get
    a Slack message when someone assigns you an issue or mentions you. Turn those messages off under
    <RouterLink to="/profile" class="link">Profile</RouterLink>.
  </p>
  <p>
    To turn a Slack conversation into an issue, copy the message link in Slack (<em>Copy link</em> on the message) and paste it in the
    Create issue form. The bot must be a member of that channel.
  </p>
  <p>
    When an admin has set up the command, type <code>/tracker help</code> in Slack.
    <code>/tracker create WEB Fix the login page</code> creates an issue, <code>/tracker WEB-12</code> shows one, and
    <code>/tracker mine</code> lists your open issues. On any message, More actions &gt; <em>Create issue in Tracker</em> opens a form with
    the message filled in. These work when your Slack email is the same as your email here, and only with your own rights.
  </p>
</template>
