<script setup>
// Help: AI assistants (MCP)
const origin = location.origin;
</script>
<template>
  <p>
    AI assistants such as Claude, ChatGPT, GitHub Copilot and Cursor can work with the tracker through its MCP server: ask "what is assigned
    to me?", "create a bug in WEB for the login error", or "move WEB-12 to Done and comment that it shipped". The assistant acts as you,
    with exactly your permissions.
  </p>
  <p>
    The server address is <code>{{ origin }}/mcp</code>.
  </p>
  <ul class="list-disc space-y-1 pl-5">
    <li>
      <strong>Claude.ai, Claude Desktop and ChatGPT</strong>: add a custom connector with that address. You sign in to the tracker and
      approve it once. Remove it any time under connected apps.
    </li>
    <li>
      <strong>Claude Code, VS Code, Cursor and other developer tools</strong>: create a personal token, then use the setup command shown for
      your tool. The token works like a password: keep it private and revoke it when you stop using it.
    </li>
  </ul>
  <p>
    Setup steps for each tool and your tokens are on the <RouterLink to="/ai" class="link">AI connectors</RouterLink> page (or under
    <RouterLink to="/profile" class="link">Profile</RouterLink>).
  </p>
  <p>
    Every call is recorded: you see your own on the AI connectors page, and admins see everyone's under
    <strong>Admin &gt; AI audit (MCP)</strong> (who, which app or token, which tool, which issues it touched, the result and how long it
    took, with filters and a CSV export). Long text such as descriptions and comments is recorded only as its length. Comments, changes and
    work logs an assistant made are marked "via AI assistant" on the issue.
  </p>
</template>
