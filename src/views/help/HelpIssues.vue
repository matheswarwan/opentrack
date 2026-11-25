<script setup>
// Help: Issues
</script>
<template>
  <p>
    Issue types: <strong>Epic</strong> (a large piece of work that groups stories, tasks and bugs), <strong>Story</strong>,
    <strong>Task</strong>, <strong>Bug</strong> and <strong>Sub-task</strong> (a step inside a story, task or bug).
  </p>
  <p>
    Every issue has a status (its board column), priority, assignee, reporter, labels, sprint, story points, an estimate in hours and a due
    date. Click the title or description to edit them; change the rest in the panel on the right. Every change is kept under
    <strong>History</strong>.
  </p>
  <p>
    Under the description you can add sub-tasks (or stories, on an epic), link issues (blocks, relates to, duplicates, clones) and log time
    worked under <strong>Work log</strong>.
  </p>
  <p>
    <RouterLink to="/timesheet" class="link">Timesheet</RouterLink> shows the hours you logged this week by issue and day; click a cell to
    log time, and export it as CSV. Admins can also see anyone's week or the whole team.
  </p>
  <p>
    <strong>Timer:</strong> on an issue, <strong>Start timer</strong> tracks the time you work on it. The running timer shows at the top of
    every page with the issue and the elapsed time, and keeps running when you close the tab. <strong>Stop</strong> logs the time on the
    issue (rounded up to the minute) and asks for an optional note; <strong>Discard</strong> drops it. You have one timer at a time:
    starting another stops and logs the first. A timer that ran for more than 12 hours asks you to check the hours before it logs them.
  </p>
  <p>
    <strong>Submitting a week:</strong> on the Timesheet, <strong>Submit week</strong> sends your week (Monday to Sunday) for approval.
    Workspace admins, and the leads of the projects you logged time on, see it under
    <RouterLink to="/timesheet/approvals" class="link">Timesheet &gt; Approvals</RouterLink> with the hours per project, and approve or
    reject it with a comment; you get a notification either way. An approved week is locked: its work logs cannot be added, changed or
    deleted, except by a workspace admin. A rejected week can be changed and submitted again, and you can withdraw a week that is still
    waiting.
  </p>
</template>
