<script setup>
import { ref, inject, reactive, watch, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { patch, put, post, del, api, session, users as loadUsers } from '../../api.js';
import { CATEGORIES } from '../../meta.js';
import { projectsChanged } from '../../ui.js';
import { attempt, useAction } from '../../composables/useAction.js';
import Avatar from '../../components/Avatar.vue';
import UserSelect from '../../components/UserSelect.vue';
import ProjectSlack from '../../components/ProjectSlack.vue';
import ProjectChannels from '../../components/ProjectChannels.vue';
import ProjectTemplates from '../../components/ProjectTemplates.vue';
import ProjectRecurring from '../../components/ProjectRecurring.vue';
import ProjectFields from '../../components/ProjectFields.vue';
import ProjectComponents from '../../components/ProjectComponents.vue';
import WebhooksPanel from '../../components/WebhooksPanel.vue';
import ProjectWorkflow from '../../components/ProjectWorkflow.vue';
import ProjectSaveTemplate from '../../components/ProjectSaveTemplate.vue';
import ProjectBudget from '../../components/ProjectBudget.vue';
import ProjectCapacity from '../../components/ProjectCapacity.vue';

const project = inject('project');
const reloadProject = inject('reloadProject');
const router = useRouter();
const details = reactive({});
watch(
  project,
  (p) => Object.assign(details, { name: p.name, description: p.description || '', visibility: p.visibility, leadId: p.leadId }),
  { immediate: true },
);
const newStatus = reactive({ name: '', category: 'in_progress' });
const newMember = reactive({ userId: null, role: 'member' });
// Guests (external clients) get one of three guest levels; everyone else a normal role.
const MEMBER_ROLES = [
  ['admin', 'Project admin'],
  ['member', 'Member'],
  ['viewer', 'Viewer'],
];
const GUEST_ROLES = [
  ['guest-view', 'Guest: read only'],
  ['guest-comment', 'Guest: can comment'],
  ['guest-edit', 'Guest: can create and edit own'],
];
const people = ref([]);
onMounted(async () => {
  try {
    people.value = await loadUsers();
  } catch {
    /* picker still works */
  }
});
const newIsGuest = computed(() => Boolean(people.value.find((u) => u.id === newMember.userId)?.guest));
watch(newIsGuest, (g) => {
  newMember.role = g ? 'guest-view' : 'member';
});
const roleOptions = (guest) => (guest ? GUEST_ROLES : MEMBER_ROLES);
// Project permissions (who may delete, manage sprints, create issues, comment)
const perms = reactive({});
watch(project, (p) => Object.assign(perms, p.permissions || {}), { immediate: true });
const savePerms = () => run(() => patch(base(), { permissions: { ...perms } }), 'Permissions saved');
const deleting = ref(null);

// every settings change reloads the project that the layout provides
const run = (fn, ok) => attempt(fn, { ok, then: reloadProject });
const base = () => `/api/projects/${project.value.key}`;
const saveDetails = () => run(() => patch(base(), details), 'Project saved');
const addStatus = () =>
  run(async () => {
    await post(`${base()}/statuses`, newStatus);
    newStatus.name = '';
  }, 'Status added');
const saveStatus = (s, change) => run(() => patch(`${base()}/statuses/${s.id}`, change));
function move(i, dir) {
  const ids = project.value.statuses.map((s) => s.id);
  const j = i + dir;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  run(() => put(`${base()}/statuses`, { order: ids }));
}
const removeStatus = () =>
  run(async () => {
    await del(`${base()}/statuses/${deleting.value.id}?moveTo=${deleting.value.moveTo || ''}`);
    deleting.value = null;
  }, 'Status deleted');
const addMember = () =>
  run(async () => {
    await put(`${base()}/members/${newMember.userId}`, { role: newMember.role });
    newMember.userId = null;
  }, 'Member added');
const setRole = (m, role) => run(() => put(`${base()}/members/${m.userId}`, { role }));
const removeMember = (m) => run(() => del(`${base()}/members/${m.userId}`));
async function archive(flag) {
  if (flag && !confirm('Archive this project? It is hidden from lists and becomes read only.')) return;
  await run(() => patch(base(), { archived: flag }), flag ? 'Project archived' : 'Project restored');
  if (flag) router.push('/projects');
}
// Delete the project (workspace admins): it goes to the Trash, restorable until it is purged
const deleteKey = ref('');
const { busy: projectDeleting, run: deleteAction } = useAction();
async function deleteProject() {
  await deleteAction(() => api('DELETE', `/api/projects/${project.value.key}`, { confirm: deleteKey.value }), {
    ok: (r) => `${r.key} moved to the Trash (kept ${r.trashDays} days)`,
    then: () => {
      projectsChanged();
      router.push('/projects');
    },
  });
}
</script>
<template>
  <div class="grid max-w-5xl gap-4 lg:grid-cols-2">
    <form class="card space-y-3 p-4" @submit.prevent="saveDetails">
      <h2 class="text-sm font-semibold">Details</h2>
      <div><label class="label" for="ps-name">Name</label><input id="ps-name" v-model="details.name" class="input" required /></div>
      <div>
        <label class="label" for="ps-desc">Description</label
        ><textarea id="ps-desc" v-model="details.description" class="input" rows="3"></textarea>
      </div>
      <div><label class="label">Lead</label><UserSelect v-model="details.leadId" :allow-none="false" /></div>
      <div>
        <label class="label" for="ps-vis">Who can see it</label>
        <select id="ps-vis" v-model="details.visibility" class="input">
          <option value="open">Everyone in the workspace (everyone can add and edit issues)</option>
          <option value="private">Project members only</option>
        </select>
      </div>
      <div class="flex gap-2">
        <button class="btn btn-primary">Save</button>
        <button type="button" class="btn btn-danger ml-auto" @click="archive(!project.archived)">
          {{ project.archived ? 'Restore project' : 'Archive project' }}
        </button>
      </div>
    </form>

    <div class="card p-4">
      <h2 class="mb-2 text-sm font-semibold">Workflow (board columns)</h2>
      <div v-for="(s, i) in project.statuses" :key="s.id" class="flex items-center gap-2 border-b border-slate-100 py-1.5">
        <div class="flex flex-col">
          <button
            class="text-xs leading-none text-slate-400 hover:text-slate-800 disabled:opacity-30"
            :disabled="i === 0"
            aria-label="Move up"
            @click="move(i, -1)"
          >
            ▲</button
          ><button
            class="text-xs leading-none text-slate-400 hover:text-slate-800 disabled:opacity-30"
            :disabled="i === project.statuses.length - 1"
            aria-label="Move down"
            @click="move(i, 1)"
          >
            ▼
          </button>
        </div>
        <input
          :value="s.name"
          class="input py-1"
          :aria-label="'Name of ' + s.name"
          @change="saveStatus(s, { name: $event.target.value })"
        />
        <select
          :value="s.category"
          class="input w-36 py-1"
          aria-label="Category"
          @change="saveStatus(s, { category: $event.target.value })"
        >
          <option v-for="c in CATEGORIES" :key="c.id" :value="c.id">{{ c.label }}</option>
        </select>
        <input
          :value="s.wipLimit ?? ''"
          type="number"
          min="0"
          class="input w-20 py-1"
          placeholder="WIP"
          aria-label="WIP limit"
          @change="saveStatus(s, { wipLimit: $event.target.value === '' ? null : Number($event.target.value) })"
        />
        <button
          class="text-slate-400 hover:text-red-700"
          :aria-label="'Delete ' + s.name"
          @click="deleting = { id: s.id, name: s.name, moveTo: project.statuses.find((x) => x.id !== s.id)?.id }"
        >
          ×
        </button>
      </div>
      <div v-if="deleting" class="mt-2 rounded-md bg-amber-50 p-2 text-sm">
        Delete <strong>{{ deleting.name }}</strong>. Move its issues to
        <select v-model="deleting.moveTo" class="input mx-1 inline-block w-auto py-0.5">
          <option v-for="s in project.statuses.filter((x) => x.id !== deleting.id)" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select>
        <button class="btn btn-sm btn-danger" @click="removeStatus">Delete</button>
        <button class="btn btn-sm" @click="deleting = null">Cancel</button>
      </div>
      <form class="mt-3 flex gap-2" @submit.prevent="addStatus">
        <input v-model="newStatus.name" class="input" placeholder="New status, e.g. QA" required maxlength="40" />
        <select v-model="newStatus.category" class="input w-36" aria-label="Category of the new status">
          <option v-for="c in CATEGORIES" :key="c.id" :value="c.id">{{ c.label }}</option>
        </select>
        <button class="btn">Add</button>
      </form>
      <p class="mt-2 text-xs text-slate-500">
        The category decides what counts as open or done (dashboards, sprint completion, resolved date).
      </p>
    </div>

    <ProjectWorkflow
      v-if="project.canAdmin"
      :key="'wf-' + project.key + project.statuses.map((x) => x.id).join()"
      :project="project"
      class="lg:col-span-2"
      @changed="reloadProject"
    />

    <ProjectSlack v-if="project.canAdmin" :key="project.key" :project-key="project.key" class="lg:col-span-2" />

    <WebhooksPanel
      v-if="project.canAdmin"
      :key="'wh-' + project.key"
      :base="`/api/projects/${project.key}/webhooks`"
      intro="Send a signed JSON message to another system when something happens in this project."
      class="lg:col-span-2"
    />
    <ProjectChannels v-if="project.canAdmin" :key="'ch-' + project.key" :project-key="project.key" class="lg:col-span-2" />

    <ProjectFields
      v-if="project.canAdmin"
      :key="'cf-' + project.key"
      :project-key="project.key"
      class="lg:col-span-2"
      @changed="reloadProject"
    />

    <ProjectComponents
      v-if="project.canAdmin"
      :key="'cmp-' + project.key"
      :project-key="project.key"
      class="lg:col-span-2"
      @changed="reloadProject"
    />

    <ProjectBudget
      v-if="project.canAdmin"
      :key="'bud-' + project.key"
      :project-key="project.key"
      :members="project.members"
      class="lg:col-span-2"
    />

    <ProjectCapacity
      v-if="project.canAdmin"
      :key="'cap-' + project.key + project.members.length"
      :project-key="project.key"
      class="lg:col-span-2"
    />

    <ProjectTemplates v-if="project.canAdmin" :key="'tpl-' + project.key" :project-key="project.key" class="lg:col-span-2" />

    <ProjectRecurring v-if="project.canAdmin" :key="'rec-' + project.key" :project-key="project.key" class="lg:col-span-2" />

    <form v-if="project.canAdmin" class="card space-y-3 p-4 lg:col-span-2" @submit.prevent="savePerms">
      <h2 class="text-sm font-semibold">Permissions</h2>
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="label" for="pp-delete">Who can delete issues</label>
          <select id="pp-delete" v-model="perms.delete" class="input">
            <option value="reporter">The reporter and project admins</option>
            <option value="admins">Project admins only</option>
          </select>
        </div>
        <div>
          <label class="label" for="pp-sprints">Who can manage sprints</label>
          <select id="pp-sprints" v-model="perms.sprints" class="input">
            <option value="members">Members</option>
            <option value="admins">Project admins only</option>
          </select>
        </div>
        <div>
          <label class="label" for="pp-create">Who can create issues</label>
          <select id="pp-create" v-model="perms.create" class="input">
            <option value="members">Members (and guests who can create)</option>
            <option value="admins">Project admins only</option>
          </select>
        </div>
        <div>
          <label class="label" for="pp-comment">Who can comment</label>
          <select id="pp-comment" v-model="perms.comment" class="input">
            <option value="all">Everyone who can see the project</option>
            <option value="members">Team members only (no guests)</option>
          </select>
        </div>
      </div>
      <p class="text-xs text-slate-500">
        Managing sprints covers creating, starting, completing and deleting sprints and moving issues between sprints. Viewers can never
        comment or change issues. Workspace admins can always do everything.
      </p>
      <button class="btn btn-primary">Save permissions</button>
    </form>

    <div class="card p-4 lg:col-span-2">
      <h2 class="mb-2 text-sm font-semibold">Members</h2>
      <p class="mb-2 text-xs text-slate-500">
        Project admins manage settings, members and the workflow. In a members-only project, only members see it; viewers there can read but
        not change issues. Workspace admins can always see every project.
      </p>
      <p class="mb-2 text-xs text-slate-500">
        Guests are people outside your organization, such as clients. They see only the projects they are added to, never internal notes.
        Read only: they can read issues and comments. Can comment: they can also comment, add files to comments and watch issues. Can create
        and edit own: they can also create issues and change the issues they reported. Guests cannot delete issues, manage sprints or change
        settings.
      </p>
      <div v-for="m in project.members" :key="m.userId" class="flex flex-wrap items-center gap-2 border-b border-slate-100 py-1.5 text-sm">
        <Avatar :user="m" :size="24" /><span class="min-w-0 flex-1 truncate"
          >{{ m.name }} <span class="text-xs text-slate-500">{{ m.email }}</span></span
        >
        <span v-if="m.guest" class="chip bg-amber-100 text-amber-900">Guest</span>
        <select :value="m.role" class="input w-36 py-1 sm:w-56" :aria-label="'Role of ' + m.name" @change="setRole(m, $event.target.value)">
          <option v-for="r in roleOptions(m.guest)" :key="r[0]" :value="r[0]">{{ r[1] }}</option>
        </select>
        <button class="text-slate-400 hover:text-red-700" :aria-label="'Remove ' + m.name" @click="removeMember(m)">×</button>
      </div>
      <form class="mt-3 flex flex-wrap items-center gap-2" @submit.prevent="newMember.userId && addMember()">
        <div class="w-full sm:w-64"><UserSelect v-model="newMember.userId" placeholder="Choose a person" :allow-none="false" /></div>
        <select v-model="newMember.role" class="input w-auto" aria-label="Role">
          <option v-for="r in roleOptions(newIsGuest)" :key="r[0]" :value="r[0]">{{ r[1] }}</option>
        </select>
        <button class="btn" :disabled="!newMember.userId">Add member</button>
      </form>
    </div>

    <ProjectSaveTemplate
      v-if="project.canAdmin && !project.guest"
      :key="'pst-' + project.key"
      :project-key="project.key"
      :project-name="project.name"
      class="lg:col-span-2"
    />

    <div v-if="project.canAdmin" class="card space-y-2 p-4 lg:col-span-2">
      <h2 class="text-sm font-semibold">Export</h2>
      <p class="text-xs text-slate-500">
        CSV: one row per issue (not the Trash), for a spreadsheet. JSON: the whole project in the backup format (issues including the Trash,
        comments, history, links, work logs, sprints, workflow, members, templates; attachments listed, files not included). Admins can
        download a backup of the whole workspace under Admin &gt; Backups.
      </p>
      <div class="flex flex-wrap gap-2">
        <a class="btn" :href="`/api/projects/${project.key}/export.csv`" download>Download CSV</a>
        <a class="btn" :href="`/api/projects/${project.key}/export.json`" download>Download JSON</a>
        <RouterLink class="btn" :to="`/trash?project=${project.key}`">Open the Trash</RouterLink>
      </div>
    </div>

    <div v-if="session.user?.role === 'admin'" class="card space-y-2 border-red-200 p-4 lg:col-span-2" data-danger-zone>
      <h2 class="text-sm font-semibold text-red-800">Delete project</h2>
      <p class="text-xs text-slate-600">
        The project and everything in it (issues, comments, history, files, sprints, settings) go to the Trash: hidden from everyone,
        restorable by an admin from the Trash until it is emptied, then removed for good. Download the JSON export first if you want your
        own copy. To archive instead (read only, still searchable), use Archive project above.
      </p>
      <form class="flex flex-wrap items-end gap-2" @submit.prevent="deleteProject">
        <label class="w-56"
          ><span class="label">Type {{ project.key }} to confirm</span
          ><input v-model="deleteKey" class="input uppercase" autocomplete="off" :placeholder="project.key"
        /></label>
        <button type="submit" class="btn btn-danger" :disabled="projectDeleting || deleteKey.trim().toUpperCase() !== project.key">
          {{ projectDeleting ? 'Deleting…' : 'Delete project' }}
        </button>
      </form>
    </div>
  </div>
</template>
