<script setup>
// Help: Portfolio
</script>
<template>
  <p>
    <RouterLink to="/portfolio" class="link">Portfolio</RouterLink> shows every project you can see on one page: its lead, health, how much
    is done (by issue count and by story points, epics and sub-tasks left out), open, overdue and blocked issues, open high priority bugs,
    the next release with its date, the active sprint, budget used (when budgets are set up; not shown to guests) and the last change to an
    issue. Issues in the Trash are never counted. Archived projects are hidden unless you tick <em>Show archived</em>.
  </p>
  <p>
    Health is the Overall RAG of the project's latest published status report, with a link to it. A project without one shows
    <em>No report</em> and a <em>computed</em> RAG from the same rules as the status report suggestion: overdue and blocked issues, releases
    past their date, high priority bugs and hours logged against estimates. It does not include the sprint burndown, so it can be milder
    than a report would be.
  </p>
  <p>
    The tiles at the top count projects by health and add up overdue and blocked issues and releases due in the next 14 days; click a health
    tile to filter. The Milestones strip shows releases with a date in the next 90 days. Filter by project name or key, lead, health or
    <em>My projects</em> (projects you lead or are a member of), sort by any column, and use <strong>Copy link</strong> to share the view
    with its filters or <strong>Export CSV</strong> for a spreadsheet. Guests see only the projects they were added to and only reports
    shared with guests.
  </p>
</template>
