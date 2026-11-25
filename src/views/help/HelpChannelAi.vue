<script setup>
// Help: Channel AI sessions
</script>
<template>
  <p>
    A project can have Slack channels linked to it, each marked <strong>internal</strong> (only our team) or
    <strong>external</strong> (shared with the client). Project admins add them under Project settings &gt; Channels. The bot must be in the
    channel.
  </p>
  <p>
    On an issue, choose <strong>Link a channel</strong> under Channels. Pick a channel, optionally paste a Slack message link to follow only
    that thread, and write who is who, for example "Dana (client PM) decides scope. Raj is our developer. Messages from Priya are QA
    findings." You can link several channels or threads to one issue.
  </p>
  <p>
    A project admin can then turn on the <strong>AI session</strong> for the link. Every 30 minutes the AI reads the new messages and posts
    a short internal note on the issue (by Tracker AI, with links to the messages), and lists suggested changes under
    <strong>Suggested by AI</strong>: a new status, assignee, due date, priority, a sub-task or a note. Anyone who can edit the issue can
    Apply or Dismiss each one; applied changes show in the history like any other change. A project admin can let notes and sub-tasks be
    added without asking; the other changes always need a click.
  </p>
  <p>
    Nothing is posted back to Slack. Workspace admins allow sessions under Admin &gt; Settings, with a separate switch for external
    channels. What is sent to the AI is listed in the questions below ("What does the AI see in a channel AI session?").
  </p>
</template>
