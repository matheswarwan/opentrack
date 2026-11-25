<script setup>
// Help: Status reports
</script>
<template>
  <p>
    Each project has a <strong>Status</strong> tab with its weekly status reports for the client. Project admins click
    <strong>New status report</strong>; the draft covers the last 7 days unless you pick other dates, and is filled from the tracker: work
    done in the period (grouped by epic), work in progress, what is planned next (the next sprint and work due in the following week),
    releases with their dates, risks and blockers (blocked, overdue and high priority issues) and the hours logged, when there are any.
  </p>
  <p>
    The app suggests a RAG status (Red, Amber, Green) for Scope, Schedule, Quality and, when the project has a budget or issues have hour
    estimates, Budget, plus an Overall status that is the worst of them. Schedule looks at overdue and blocked issues, releases past their
    date and the active sprint against its ideal burndown. Scope looks at work added to the sprint after it started. Quality counts open
    high priority bugs. Budget uses the project budget when there is one: Amber at its first alert threshold or when the forecast is over
    the budget, Red at 100% used or when the forecast is more than 10% over (shown as percentages, never amounts of money). Without a budget
    it compares hours logged with the estimate and the share of estimated work done. You can change any of them; a change needs a reason,
    which the client sees.
  </p>
  <p>
    Project admins set a <strong>budget</strong> under Project settings &gt; Budget: hours, or money (billable hours x hourly rates, with
    rates per role or person and an effective-from date so a change does not reprice earlier work). Work is billable unless marked otherwise
    when logging it, or later in the Timesheet. The Budget card on the Reports tab shows the burn-up, the forecast to completion and the
    hours per epic and person; members see hours and percentages only. Project admins get a notification when usage passes each alert
    threshold.
  </p>
  <p>
    Edit the draft: write the summary (or use <strong>Draft with AI</strong> when an admin has turned on AI), remove or reorder issues, add
    notes and decisions the client needs to make, and mark a section <em>Internal only</em>. <strong>Publish</strong> notifies the project
    members. Tick <em>Share with guests</em> before publishing to let the project's guests read it and notify them too; guests never see
    drafts, internal sections or the numbers behind the suggestions. Published reports are read only: a project admin can unpublish one to
    change it. <strong>Copy as text</strong> copies it as Markdown, and <strong>Download</strong> opens a print page to save as PDF.
  </p>
</template>
