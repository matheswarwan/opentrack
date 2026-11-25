<script setup>
// Help: Roles and what they can do
</script>
<template>
  <div class="overflow-x-auto">
    <table class="w-full border-collapse text-left">
      <thead>
        <tr class="border-b border-slate-200 text-xs uppercase text-slate-500">
          <th class="py-1.5 pr-3">Role</th>
          <th class="py-1.5">What they can do</th>
        </tr>
      </thead>
      <tbody>
        <tr class="border-b border-slate-100 align-top">
          <td class="py-1.5 pr-3 font-medium">Guest</td>
          <td class="py-1.5">
            For clients and other people outside your organization. Sees only the projects they are added to (never open projects) and never
            internal notes. Per project: <em>read only</em>; <em>can comment</em> (also add files to comments and watch); or
            <em>can create and edit own</em> (also create issues and change the issues they reported). Cannot delete issues, manage sprints,
            change settings, create projects, see the Trash or use AI connectors and API tokens. The people picker shows only the members of
            their projects.
          </td>
        </tr>
        <tr class="border-b border-slate-100 align-top">
          <td class="py-1.5 pr-3 font-medium">Viewer</td>
          <td class="py-1.5">
            Read projects, issues, boards and comments they can see. Get notifications, watch issues, send feedback. Cannot create or change
            anything.
          </td>
        </tr>
        <tr class="border-b border-slate-100 align-top">
          <td class="py-1.5 pr-3 font-medium">Member</td>
          <td class="py-1.5">
            Everything a viewer can, plus create and edit issues, comment, log work, move cards, plan sprints, and create projects (unless
            admins turned that off).
          </td>
        </tr>
        <tr class="border-b border-slate-100 align-top">
          <td class="py-1.5 pr-3 font-medium">Project admin</td>
          <td class="py-1.5">
            A member who also runs one project: its settings, workflow columns, members and who can see it. The project lead and the person
            who created it are project admins.
          </td>
        </tr>
        <tr class="align-top">
          <td class="py-1.5 pr-3 font-medium">Admin</td>
          <td class="py-1.5">
            Runs the workspace: adds and removes people, sets roles, workspace settings, Google sign-in, Slack, feedback and the audit log.
            Sees every project.
          </td>
        </tr>
      </tbody>
    </table>
  </div>
  <p>
    A project open to <em>everyone</em> can be read and edited by every member. A <em>members only</em> project is visible only to the
    people listed in its settings (and to admins); people listed there as viewers can read but not change it. Guests see a project only when
    they are listed in it.
  </p>
  <p>
    Project admins can narrow things further under Project settings &gt; Permissions: who can delete issues (the reporter and project
    admins, or project admins only), who can manage sprints, who can create issues (members, or project admins only) and who can comment
    (everyone who can see the project, or team members only). Viewers never comment or change issues, whatever these settings say.
  </p>
</template>
