<script setup>
// Help: RAID log
</script>
<template>
  <p>
    Each project has a <strong>RAID</strong> tab: a register of <strong>risks</strong>, <strong>assumptions</strong>,
    <strong>issues</strong> and <strong>decisions</strong> that the project manager keeps next to the work. Each entry has a title, a
    description (Markdown), an owner, a status, a review date and, if you like, links to issues of the project. Entries are numbered per
    project (RAID-1, RAID-2 and so on) and keep a history of every change.
  </p>
  <p>
    A risk also has a probability and an impact from 1 to 5; its score is probability x impact (1 to 25), plus a mitigation (what you do now
    to make it less likely or smaller) and a contingency (what you do if it happens). A decision has who decided it, when, and why. Risks,
    assumptions and issues are Open, Monitoring or Closed; decisions are Proposed, Agreed or Superseded.
  </p>
  <p>
    The heat map shows open risks by probability and impact, with the count in each cell. Click a cell to list only those risks; click it
    again to clear. Filter by type, status, owner or <em>Overdue</em> (past the review date and not closed), sort, and use
    <strong>Export CSV</strong> for a spreadsheet. An issue linked to entries shows them in a RAID box on the issue page.
  </p>
  <p>
    The owner gets a notification when they are made owner, and the daily due-date reminder also lists entries they own whose review date is
    today, tomorrow or past. A new status report draft has a <strong>Top risks</strong> section with up to 5 open risks scoring 12 or more;
    it starts as <em>Internal only</em>.
  </p>
  <p>
    Project members can read the log, members who can edit issues add and change entries, and project admins delete them. Viewers read only.
    Guests never see the RAID tab or its entries, and cannot own one. AI assistants can read it with the <code>list_raid</code> tool.
  </p>
</template>
