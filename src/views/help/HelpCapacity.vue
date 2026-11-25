<script setup>
// Help: Capacity
</script>
<template>
  <p>
    <RouterLink to="/capacity" class="link">Capacity</RouterLink> shows whether people are over- or under-booked for the next 8 weeks. Each
    cell is booked hours / available hours for one person and week, with the percentage and a word: <em>Light</em> (under 70%),
    <em>Good</em> (70 to 100%), <em>Over</em> (above 100%) or <em>Overloaded</em> (above 120%). A dashed outline and <em>Away</em> mark
    weeks with time off. Click a cell to see the issues behind it. The <em>Unscheduled</em> column holds work with no dates to place it.
    <strong>Export CSV</strong> downloads the grid.
  </p>
  <p>
    Available hours: your weekly hours (the workspace default, usually 40, unless you set your own under <em>My availability</em>) divided
    over Monday to Friday, minus time off. In the current week only today and later count. Booked hours: what is left on your open issues
    (estimate minus time logged; issues without an estimate are not counted), spread evenly over the weekdays from the start date (or today)
    to the due date. Without a due date, an issue in a sprint with dates is spread to the end of the sprint; otherwise it is unscheduled.
    Overdue work counts in the current week.
  </p>
  <p>
    <em>Work from</em> limits the booked work to one project; available hours then use each person's allocation for that project, set by
    project admins under Project settings &gt; Capacity. Without an allocation, a person in one project counts fully, and someone in several
    projects shares evenly what their other allocations leave. <em>People</em> limits the rows to one project's members.
  </p>
  <p>
    You see the people who share a project with you; admins see everyone. Hours on projects you cannot see are counted but not named.
    Time-off notes are shown only to the person and admins; everyone else sees <em>Away</em>. Admins can change anyone's hours and time off
    by clicking their name. In the backlog, each sprint with dates shows the team's available hours against the estimated work left in it.
  </p>
</template>
