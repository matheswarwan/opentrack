<script setup>
// Help: The board
</script>
<template>
  <p>
    Drag cards between columns to change their status, and up or down to change their order. When the project has an active sprint, the
    board shows that sprint; switch to <em>All issues</em> at the top left.
  </p>
  <ul class="list-disc space-y-1 pl-5">
    <li>Filter by text, by person (click the names), type or label, or <em>Only my issues</em>.</li>
    <li>
      <em>Group by</em> assignee or epic adds a row per person or epic. Dragging a card into another row reassigns it or moves it to that
      epic.
    </li>
    <li>A column turns red when it has more issues than its limit (set by the project admin).</li>
    <li>
      When the project has workflow rules, the columns a card cannot move to are dimmed while you drag it. If the new status needs values
      (for example a fix version), a small dialog asks for them.
    </li>
    <li>
      <strong>Switch project</strong> (top of the sidebar): every project, recently opened first, with a filter, Browse all projects and New
      project. Picking one keeps you on the same page (board, backlog, RAID...). <strong>Board</strong> in the sidebar opens the board of
      the project you are in or opened last.
    </li>
    <li>
      <strong>Calendar</strong> (in the sidebar, and a tab in each project): issues on their due date, by month or week. Drag an issue to
      another day to change its due date, use + on a day to create one due that day, and <em>Subscribe</em> for a private link to add them
      to Google Calendar or Outlook.
    </li>
    <li>Done issues older than 14 days are hidden on the all-issues board; the link under the board shows them.</li>
    <li>Click a card to open it in a side panel without leaving the board.</li>
    <li>
      <strong>Views</strong> saves the current filters under a name, for you only or shared with the project. Pick
      <em>Use as my default</em> and the board opens with that view. You can rename, update or delete your own views; project admins can
      delete shared ones.
    </li>
  </ul>
</template>
