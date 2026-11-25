<script setup>
// Help: Search, filters and export
</script>
<template>
  <p>
    <RouterLink to="/issues" class="link">Issues</RouterLink> searches every project you can see. Type words or a key, and narrow by
    project, type, status, assignee, priority or label. Click a column heading to sort.
  </p>
  <p>
    <strong>Save filter</strong> keeps the current search in the left list; tick <em>Share with everyone</em> to let others use it.
    <strong>Export CSV</strong> downloads the results (up to 1,000 rows) for Excel or Google Sheets.
  </p>
  <p>
    The search box in the header jumps straight to an issue when you type its key, or searches when you type words. Press <kbd>/</kbd> to
    get there.
  </p>
</template>
