<script setup>
import { ref, reactive, computed } from 'vue';
import { get, post, patch, del, session, toast, users as refreshPicker } from '../../api.js';
import { downloadText, copyText } from '../../browser.js';
import { parseUserRows, toCsv } from '../../csv.js';
import { ago } from '../../meta.js';
import Modal from '../../components/Modal.vue';
import Avatar from '../../components/Avatar.vue';
import LoadState from '../../components/LoadState.vue';
import { attempt } from '../../composables/useAction.js';
import { useLoad } from '../../composables/useLoad.js';
import { plural } from '../../plural.js';

const q = ref('');
const statusFilter = ref('');
const adding = ref(false);
const bulk = ref(false);
const link = ref(null); // { name, link, expiresAt }
const pwFor = ref(null);
const newPw = ref('');
const error = ref('');
const form = reactive({ email: '', name: '', title: '', role: 'member', mode: 'invite', password: '' });
const csv = ref('');
const bulkResults = ref(null);
// email (when the server has it configured): send invite and reset links by email too
const emailOn = ref(false);
const bulkEmail = ref(true);
const linkFor = ref(null); // { user, send } while choosing how to share a new link
const allowedDomains = ref([]); // Admin > Settings > Security; people outside it are marked

const {
  data: list,
  loading,
  error: loadError,
  reload: load,
} = useLoad(
  async () => {
    const r = await get('/api/admin/users');
    emailOn.value = Boolean(r.emailConfigured);
    allowedDomains.value = r.allowedDomains || [];
    return r.users;
  },
  null,
  { initial: [] },
);
const shown = computed(() => {
  const s = q.value.toLowerCase();
  return list.value.filter(
    (u) =>
      (!statusFilter.value || u.status === statusFilter.value) &&
      (!s || u.name.toLowerCase().includes(s) || u.email.toLowerCase().includes(s)),
  );
});
const outsideTitle = computed(
  () => `This email is outside the allowed domains (${allowedDomains.value.join(', ')}). The account keeps working.`,
);
const counts = computed(() => ({
  active: list.value.filter((u) => u.status === 'active').length,
  invited: list.value.filter((u) => u.status === 'invited').length,
  deactivated: list.value.filter((u) => u.status === 'deactivated').length,
}));

function openAdd() {
  Object.assign(form, { email: '', name: '', title: '', role: 'member', mode: 'invite', password: '', sendEmail: emailOn.value });
  error.value = '';
  adding.value = true;
}
async function add() {
  error.value = '';
  try {
    const r = await post('/api/admin/users', {
      email: form.email,
      name: form.name,
      title: form.title,
      role: form.role,
      password: form.mode === 'password' ? form.password : undefined,
      sendEmail: form.mode === 'invite' && emailOn.value && form.sendEmail,
    });
    adding.value = false;
    await load();
    refreshPicker(true);
    if (r.user.inviteLink)
      link.value = {
        name: r.user.name,
        email: r.user.email,
        link: r.user.inviteLink,
        expiresAt: r.user.inviteExpiresAt,
        emailed: r.user.emailed,
        emailError: r.user.emailError,
      };
    else toast(`${r.user.name} can now sign in with the password you set`);
  } catch (e) {
    error.value = e.message;
  }
}
const reloadAll = async () => {
  await load();
  refreshPicker(true);
};
async function update(u, change) {
  const saved = await attempt(() => patch(`/api/admin/users/${u.id}`, change), { ok: 'Saved', then: reloadAll });
  if (!saved) await load(); // the row's select goes back to the stored value
}
async function newLink(u, sendEmail = false) {
  linkFor.value = null;
  await attempt(() => post(`/api/admin/users/${u.id}/invite`, { sendEmail }), {
    then: (r) => {
      link.value = {
        name: u.name,
        email: u.email,
        link: r.link,
        expiresAt: r.expiresAt,
        reset: u.status === 'active',
        emailed: r.emailed,
        emailError: r.emailError,
      };
    },
  });
}
async function removePhoto(u) {
  if (!confirm(`Remove the profile photo of ${u.name}?`)) return;
  await attempt(() => del(`/api/admin/users/${u.id}/avatar`), { ok: 'Photo removed', then: reloadAll });
}
async function signOutEverywhere(u) {
  const self = u.id === session.user.id;
  if (
    !confirm(
      self
        ? 'Sign out of all your other sessions? This browser stays signed in.'
        : `Sign ${u.name} out of every browser? They can sign in again.`,
    )
  )
    return;
  await attempt(() => post(`/api/admin/users/${u.id}/sessions/revoke`), {
    ok: (r) => `${u.name}: signed out of ${r.count} ${plural(r.count, 'session')}`,
  });
}
async function resetTwoFactor(u) {
  if (
    !confirm(
      `Reset two-factor sign-in for ${u.name}? It is turned off, their recovery codes stop working and they are signed out. They sign in with their password and can set it up again. Only do this when you are sure who is asking.`,
    )
  )
    return;
  await attempt(() => post(`/api/admin/users/${u.id}/2fa/reset`), { ok: `Two-factor sign-in reset for ${u.name}`, then: load });
}
const signIn = (u) =>
  [u.hasPassword && 'Password', u.google && 'Google', u.twoFactor && 'Two-factor'].filter(Boolean).join(', ') || 'Not set up';
async function setPassword() {
  const name = pwFor.value.name;
  await attempt(() => post(`/api/admin/users/${pwFor.value.id}/password`, { password: newPw.value }), {
    ok: `Password set for ${name}. They were signed out everywhere.`,
    then: () => {
      pwFor.value = null;
      newPw.value = '';
      return load();
    },
  });
}
const copy = (text) => copyText(text);

const parsed = computed(() => parseUserRows(csv.value));
async function runBulk() {
  await attempt(() => post('/api/admin/users/bulk', { users: parsed.value, sendEmail: emailOn.value && bulkEmail.value }), {
    then: (r) => {
      bulkResults.value = r.results;
      return reloadAll();
    },
  });
}
function downloadLinks() {
  const rows = bulkResults.value.filter((x) => x.ok).map((r) => [r.user.email, r.user.name, r.user.inviteLink]);
  downloadText('invite-links.csv', toCsv([['email', 'name', 'invite_link'], ...rows]), 'text/csv');
}
// What an admin can do to one person: the buttons of the phone card and of the table row.
function actionsFor(u) {
  const list = [];
  if (u.avatarUrl) list.push({ label: 'Remove photo', run: () => removePhoto(u) });
  if (u.status === 'deactivated') return [...list, { label: 'Reactivate', run: () => update(u, { status: 'active' }) }];
  list.push(
    {
      label: u.status === 'invited' ? 'New invite link' : 'Reset link',
      run: () => (emailOn.value ? (linkFor.value = { user: u, send: true }) : newLink(u)),
    },
    {
      label: 'Set password',
      run: () => {
        pwFor.value = u;
        newPw.value = '';
      },
    },
    { label: 'Sign out everywhere', run: () => signOutEverywhere(u) },
  );
  if (u.twoFactor) list.push({ label: 'Reset two-factor', run: () => resetTwoFactor(u) });
  if (u.id !== session.user.id) list.push({ label: 'Deactivate', danger: true, run: () => update(u, { status: 'deactivated' }) });
  return list;
}
async function readFile(e) {
  const f = e.target.files[0];
  if (f) csv.value = await f.text();
}
const statusCls = {
  active: 'bg-green-100 text-green-800',
  invited: 'bg-amber-100 text-amber-800',
  deactivated: 'bg-slate-200 text-slate-600',
};
</script>

<template>
  <div class="mb-3 flex flex-wrap items-center gap-2">
    <input v-model="q" class="input w-full sm:w-64" placeholder="Search name or email" />
    <select v-model="statusFilter" class="input w-44" aria-label="Status">
      <option value="">All ({{ list.length }})</option>
      <option value="active">Active ({{ counts.active }})</option>
      <option value="invited">Invited ({{ counts.invited }})</option>
      <option value="deactivated">Deactivated ({{ counts.deactivated }})</option>
    </select>
    <div class="ml-auto flex gap-2">
      <button
        class="btn"
        @click="
          bulk = true;
          bulkResults = null;
          csv = '';
        "
      >
        Import from CSV
      </button>
      <button class="btn btn-primary" @click="openAdd">Add user</button>
    </div>
  </div>
  <LoadState :loading="loading" :error="loadError" @retry="load">
    <!-- phones: one card per person -->
    <div class="space-y-2 md:hidden">
      <div v-for="u in shown" :key="u.id" class="card p-3 text-sm">
        <div class="flex items-center gap-2.5">
          <Avatar :user="u" :size="34" />
          <div class="min-w-0 flex-1">
            <div class="truncate font-medium">
              {{ u.name }}<span v-if="u.id === session.user.id" class="ml-1 text-xs text-slate-400">(you)</span>
            </div>
            <div class="truncate text-xs text-slate-500">{{ u.email }}</div>
          </div>
          <span class="chip capitalize" :class="statusCls[u.status]">{{ u.status }}</span>
        </div>
        <div v-if="u.outsideDomains" class="mt-2 flex flex-wrap gap-1.5">
          <span v-if="u.outsideDomains" class="chip bg-amber-100 text-amber-900" :title="outsideTitle">Outside allowed domains</span>
        </div>
        <div class="mt-2 flex items-center gap-2 text-xs text-slate-600">
          <select
            :value="u.role"
            class="input w-28 py-1 text-sm"
            :aria-label="'Role of ' + u.name"
            @change="update(u, { role: $event.target.value })"
          >
            <option value="admin">Admin</option>
            <option value="member">Member</option>
            <option value="viewer">Viewer</option>
            <option value="guest">Guest</option>
          </select>
          <span>{{ signIn(u) }} · {{ u.lastLoginAt ? `signed in ${ago(u.lastLoginAt)}` : 'never signed in' }}</span>
        </div>
        <div class="mt-2 flex flex-wrap gap-1.5">
          <button v-for="a in actionsFor(u)" :key="a.label" class="btn btn-sm" :class="a.danger ? 'btn-danger' : ''" @click="a.run()">
            {{ a.label }}
          </button>
        </div>
      </div>
      <p v-if="!shown.length" class="py-8 text-center text-sm text-slate-500">No users match.</p>
    </div>
    <div class="card hidden overflow-x-auto md:block">
      <table class="w-full text-sm">
        <thead class="bg-slate-50 text-left text-xs uppercase text-slate-500">
          <tr>
            <th class="px-3 py-2">Name</th>
            <th class="px-3 py-2">Role</th>
            <th class="px-3 py-2">Status</th>
            <th class="px-3 py-2">Sign-in</th>
            <th class="px-3 py-2">Last sign-in</th>
            <th class="px-3 py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="u in shown" :key="u.id" class="border-t border-slate-100">
            <td class="px-3 py-2">
              <div class="flex items-center gap-2">
                <Avatar :user="u" :size="28" />
                <div>
                  <div class="font-medium">
                    {{ u.name }}<span v-if="u.id === session.user.id" class="ml-1 text-xs text-slate-400">(you)</span>
                  </div>
                  <div class="text-xs text-slate-500">
                    {{ u.email }}<span v-if="u.title"> · {{ u.title }}</span>
                  </div>
                </div>
              </div>
            </td>
            <td class="px-3 py-2">
              <select
                :value="u.role"
                class="input w-28 py-1"
                :aria-label="'Role of ' + u.name"
                @change="update(u, { role: $event.target.value })"
              >
                <option value="admin">Admin</option>
                <option value="member">Member</option>
                <option value="viewer">Viewer</option>
                <option value="guest">Guest</option>
              </select>
            </td>
            <td class="px-3 py-2">
              <span class="chip capitalize" :class="statusCls[u.status]">{{ u.status }}</span><span
                v-if="u.outsideDomains"
                class="chip ml-1 bg-amber-100 text-amber-900"
                :title="outsideTitle"
                >Outside allowed domains</span
              >
            </td>
            <td class="px-3 py-2 text-xs text-slate-600">{{ signIn(u) }}</td>
            <td class="px-3 py-2 text-xs text-slate-600">{{ u.lastLoginAt ? ago(u.lastLoginAt) : 'Never' }}</td>
            <td class="px-3 py-2">
              <div class="flex min-w-[17rem] flex-wrap justify-end gap-1">
                <button v-for="a in actionsFor(u)" :key="a.label" class="btn btn-sm" :class="a.danger ? 'btn-danger' : ''" @click="a.run()">
                  {{ a.label }}
                </button>
              </div>
            </td>
          </tr>
          <tr v-if="!shown.length">
            <td colspan="6" class="px-3 py-8 text-center text-slate-500">No users match.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </LoadState>

  <Modal v-if="adding" title="Add user" @close="adding = false">
    <form id="add-user" class="space-y-3" @submit.prevent="add">
      <div>
        <label class="label" for="au-email">Email</label
        ><input id="au-email" v-model="form.email" type="email" class="input" required autofocus />
        <p v-if="allowedDomains.length" class="mt-1 text-xs text-slate-500">Allowed domains: {{ allowedDomains.join(', ') }}</p>
      </div>
      <div><label class="label" for="au-name">Full name</label><input id="au-name" v-model="form.name" class="input" required /></div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="label" for="au-title">Job title (optional)</label><input id="au-title" v-model="form.title" class="input" />
        </div>
        <div>
          <label class="label" for="au-role">Role</label>
          <select id="au-role" v-model="form.role" class="input">
            <option value="member">Member</option>
            <option value="viewer">Viewer (read only)</option>
            <option value="guest">Guest (client)</option>
            <option value="admin">Admin</option>
          </select>
        </div>
      </div>
      <fieldset class="space-y-1.5 text-sm">
        <legend class="label">How they sign in</legend>
        <label class="flex items-start gap-2"
          ><input v-model="form.mode" type="radio" value="invite" class="mt-1" /><span
            >Create an invite link (valid 7 days) for them to set their own password</span
          ></label
        >
        <label class="flex items-start gap-2"
          ><input v-model="form.mode" type="radio" value="password" class="mt-1" /><span
            >Set a password now (account is active at once)</span
          ></label
        >
      </fieldset>
      <label v-if="form.mode === 'invite' && emailOn" class="flex items-center gap-2 text-sm"
        ><input v-model="form.sendEmail" type="checkbox" /> Send the invite link by email too</label
      >
      <div v-if="form.mode === 'password'">
        <label class="label" for="au-pw">Password (10 or more characters)</label
        ><input id="au-pw" v-model="form.password" type="text" minlength="10" class="input font-mono" required autocomplete="off" />
      </div>
      <p v-if="error" class="text-sm text-red-700">{{ error }}</p>
    </form>
    <template #footer
      ><button class="btn" @click="adding = false">Cancel</button
      ><button class="btn btn-primary" form="add-user">Add user</button></template
    >
  </Modal>

  <Modal v-if="link" :title="link.reset ? 'Password reset link' : 'Invite link'" @close="link = null">
    <p class="mb-2 text-sm">
      Send this link to <strong>{{ link.name }}</strong> ({{ link.email }}). It works once and expires
      {{ new Date(link.expiresAt).toLocaleString() }}.
    </p>
    <div class="flex gap-2">
      <input :value="link.link" class="input font-mono text-xs" readonly @focus="$event.target.select()" /><button
        class="btn"
        @click="copy(link.link)"
      >
        Copy
      </button>
    </div>
    <p v-if="link.emailed" class="mt-2 text-sm text-green-700">Emailed to {{ link.email }}.</p>
    <p v-else-if="link.emailError" class="mt-2 text-sm text-red-700">
      The email failed: {{ link.emailError }}. Copy the link and send it yourself.
    </p>
    <p class="mt-2 text-xs text-slate-500">
      <template v-if="!emailOn">Email is not set up on this server, so send the link yourself. </template>Any older unused link for this
      person no longer works.
    </p>
    <template #footer><button class="btn btn-primary" @click="link = null">Done</button></template>
  </Modal>

  <Modal v-if="linkFor" :title="linkFor.user.status === 'invited' ? 'New invite link' : 'Password reset link'" @close="linkFor = null">
    <p class="mb-2 text-sm">
      Create a new link for <strong>{{ linkFor.user.name }}</strong> ({{ linkFor.user.email }}). It works once and expires in 7 days. Any
      older unused link stops working.
    </p>
    <label class="flex items-center gap-2 text-sm"><input v-model="linkFor.send" type="checkbox" /> Send it by email too</label>
    <template #footer
      ><button class="btn" @click="linkFor = null">Cancel</button
      ><button class="btn btn-primary" @click="newLink(linkFor.user, linkFor.send)">Create link</button></template
    >
  </Modal>

  <Modal v-if="pwFor" :title="`Set password for ${pwFor.name}`" @close="pwFor = null">
    <form id="set-pw" @submit.prevent="setPassword">
      <label class="label" for="sp-pw">New password (10 or more characters)</label>
      <input id="sp-pw" v-model="newPw" type="text" minlength="10" class="input font-mono" required autocomplete="off" autofocus />
      <p class="mt-2 text-xs text-slate-500">
        This signs them out everywhere. Tell them the password in person or through a secure channel.
      </p>
    </form>
    <template #footer
      ><button class="btn" @click="pwFor = null">Cancel</button
      ><button class="btn btn-primary" form="set-pw">Set password</button></template
    >
  </Modal>

  <Modal v-if="bulk" title="Import users from CSV" wide @close="bulk = false">
    <template v-if="!bulkResults">
      <p class="mb-2 text-sm text-slate-600">
        One person per line: <code>email, name, role, title</code>. A header row with those names is fine. Role is admin, member, viewer or
        guest (default member). Guests see nothing until a project admin adds them to a project. Everyone gets an invite link.
      </p>
      <textarea
        v-model="csv"
        rows="8"
        class="input font-mono text-xs"
        placeholder="email,name,role,title&#10;jane@example.com,Jane Doe,member,Consultant"
      ></textarea>
      <input type="file" accept=".csv,.txt,.tsv" class="mt-2 text-sm" @change="readFile" />
      <p class="mt-2 text-sm text-slate-600">{{ parsed.length }} rows found.</p>
      <label v-if="emailOn" class="mt-2 flex items-center gap-2 text-sm"
        ><input v-model="bulkEmail" type="checkbox" /> Send each invite link by email too (at most 50 at a time)</label
      >
    </template>
    <template v-else>
      <p class="mb-2 text-sm">{{ bulkResults.filter((r) => r.ok).length }} added, {{ bulkResults.filter((r) => !r.ok).length }} skipped.</p>
      <div class="max-h-80 overflow-y-auto rounded border border-slate-200">
        <div v-for="(r, i) in bulkResults" :key="i" class="flex items-center gap-2 border-b border-slate-100 px-3 py-1.5 text-sm">
          <span :class="r.ok ? 'text-green-700' : 'text-red-700'">{{ r.ok ? 'Added' : 'Skipped' }}</span>
          <span class="font-medium">{{ r.ok ? r.user.email : r.email }}</span>
          <span v-if="!r.ok" class="text-slate-500">{{ r.error }}</span>
          <span v-else-if="r.user.emailed" class="text-xs text-slate-500">emailed</span>
          <span v-else-if="r.user.emailError" class="text-xs text-red-700" :title="r.user.emailError">not emailed</span>
          <button v-if="r.ok" class="link ml-auto text-xs" @click="copy(r.user.inviteLink)">Copy link</button>
        </div>
      </div>
    </template>
    <template #footer>
      <template v-if="!bulkResults"
        ><button class="btn" @click="bulk = false">Cancel</button
        ><button class="btn btn-primary" :disabled="!parsed.length" @click="runBulk">Add {{ parsed.length }} users</button></template
      >
      <template v-else
        ><button class="btn" @click="downloadLinks">Download links as CSV</button
        ><button class="btn btn-primary" @click="bulk = false">Done</button></template
      >
    </template>
  </Modal>
</template>
