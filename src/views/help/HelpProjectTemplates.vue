<script setup>
// Help: Project templates
</script>
<template>
  <p>
    A new project can start from a template instead of a blank board. Choose one under
    <strong>Projects &gt; New project &gt; Start from</strong> and give a project start date.
  </p>
  <ul class="list-disc space-y-1 pl-5">
    <li>
      <strong>Built in</strong>: Salesforce implementation (Discovery to Hypercare, client review, UAT bug template, weekly status report),
      Marketing Cloud build (data extensions, emails, CloudPages, automations, journeys, an email QA checklist), Support and managed
      services (triage to resolved, SLA tier, monthly health check, no sprints) and Internal project (To Do, Doing, Done).
    </li>
    <li>
      <strong>What a template sets up</strong>: statuses with WIP limits, workflow rules, custom fields, components, issue templates,
      recurring tasks, permissions, and starter epics, stories and tasks. Due dates such as "day 10" or "week 6" count from the start date
      ("week 6" is the fifth day of week 6). Some templates also add a first sprint, not started yet.
    </li>
    <li>
      <strong>Save your own</strong>: project admins open <strong>Project settings &gt; Save as template</strong>. It saves the setup by
      name, optionally the open epics, stories and tasks as starter issues. Comments, history and members are never saved. With "keep
      default assignees by role", work assigned to the project lead goes to the lead of each new project; other people are left out.
    </li>
    <li>
      <strong>Who sees it</strong>: a saved template is yours only until you share it with everyone (guests never see templates). You or an
      admin can share, stop sharing or delete it; admins see all saved templates under Admin &gt; Templates. Changing or deleting a template
      never changes projects made from it.
    </li>
  </ul>
</template>
