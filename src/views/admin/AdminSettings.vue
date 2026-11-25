<script setup>
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { get, post, patch, toast, session, loadMe } from '../../api.js';
import { ago } from '../../meta.js';
import ScheduledJobs from '../../components/ScheduledJobs.vue';
import ChannelAiSettings from '../../components/ChannelAiSettings.vue';
import WorkspaceFonts from '../../components/WorkspaceFonts.vue';
import { loadFonts } from '../../brand.js';
import { attempt } from '../../composables/useAction.js';

const router = useRouter();
const s = ref(null);
const googleConfigured = ref(false);
const email = ref(null);
const testing = ref(false);
// Allowed email domains are edited as text (commas, spaces or new lines) and saved as a list.
const domainsText = ref('');
onMounted(async () => {
  const [r, e] = await Promise.all([get('/api/admin/settings'), get('/api/admin/email')]);
  s.value = r.settings;
  domainsText.value = (r.settings.allowedDomains || []).join(', ');
  googleConfigured.value = r.googleConfigured;
  email.value = e;
});
async function testEmail() {
  testing.value = true;
  await attempt(async () => {
    const r = await post('/api/admin/email/test');
    toast(`Test email sent to ${r.to}`);
  });
  testing.value = false;
  email.value = await get('/api/admin/email');
}
async function save() {
  await attempt(async () => {
    s.value = (await patch('/api/admin/settings', { ...s.value, allowedDomains: domainsText.value })).settings;
    domainsText.value = (s.value.allowedDomains || []).join(', ');
    session.appName = s.value.appName;
    document.title = s.value.appName;
    loadFonts();
    toast('Settings saved');
    await loadMe(); // "Require two-factor for admins" may now apply to this admin
    if (session.twoFactorRequired) router.push('/profile');
  });
}
</script>
<template>
  <form v-if="s" class="max-w-2xl space-y-4" @submit.prevent="save">
    <div class="card space-y-3 p-4">
      <h2 class="text-sm font-semibold">Workspace</h2>
      <div>
        <label class="label" for="s-name">App name</label><input id="s-name" v-model="s.appName" class="input" required maxlength="40" />
      </div>
      <div>
        <label class="label" for="s-proj">Who can create projects</label>
        <select id="s-proj" v-model="s.projectCreation" class="input">
          <option value="everyone">Members and admins</option>
          <option value="admins">Admins only</option>
        </select>
      </div>
      <div>
        <label class="label" for="s-trash">Days a deleted issue stays in the Trash before it is removed for good</label>
        <input id="s-trash" v-model.number="s.trashDays" type="number" min="1" max="365" step="1" class="input w-28" required />
      </div>
      <div>
        <label class="label" for="s-cap">Default weekly hours for capacity planning (people can set their own)</label>
        <input id="s-cap" v-model.number="s.defaultCapacityHours" type="number" min="0" max="100" step="0.5" class="input w-28" required />
      </div>
    </div>
    <div class="card space-y-3 p-4">
      <h2 class="text-sm font-semibold">Google sign-in</h2>
      <p class="text-sm" :class="googleConfigured ? 'text-green-700' : 'text-slate-600'">
        {{
          googleConfigured
            ? 'Configured on the server: the sign-in page shows "Sign in with Google".'
            : 'Not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server to turn it on. These settings apply once it is.'
        }}
      </p>
      <div>
        <label class="label" for="s-dom"
          >Allowed Google domains (comma separated; empty allows any Google account that has a user here)</label
        ><input id="s-dom" v-model="s.googleDomains" class="input" placeholder="example.com" />
      </div>
      <label class="flex items-center gap-2 text-sm"
        ><input v-model="s.googleAutoProvision" type="checkbox" /> Create a member account the first time someone from an allowed domain
        signs in</label
      >
      <label class="flex items-center gap-2 text-sm"
        ><input v-model="s.passwordLogin" type="checkbox" /> Allow password sign-in (when off and Google is configured, only Google
        works)</label
      >
    </div>
    <div class="card space-y-3 p-4">
      <h2 class="text-sm font-semibold">Security</h2>
      <div>
        <label class="label" for="s-allowed">Allowed email domains for new accounts (separate with commas; empty allows any)</label>
        <input
          id="s-allowed"
          v-model="domainsText"
          class="input"
          placeholder="example.com, example.org"
          autocapitalize="none"
          spellcheck="false"
          aria-describedby="s-allowed-help"
        />
        <p id="s-allowed-help" class="mt-1 text-xs text-slate-500">
          Checked when an admin adds, invites or imports a person and when Google sign-in would create an account. People who already have
          an account outside the list keep it; Admin &gt; Users marks them.
        </p>
      </div>
      <div>
        <label class="label" for="s-idle"
          >Sign out sessions that are not used for this many minutes (0 = never; 15 to 10080, which is 7 days)</label
        >
        <input
          id="s-idle"
          v-model.number="s.idleTimeoutMinutes"
          type="number"
          min="0"
          max="10080"
          step="1"
          class="input w-28"
          required
          aria-describedby="s-idle-help"
        />
        <p id="s-idle-help" class="mt-1 text-xs text-slate-500">
          Use is recorded every 5 minutes at most, so a session ends up to 5 minutes later than this. An open tab that nobody touches does
          not count as use. Without this, a session lasts 30 days.
        </p>
      </div>
      <div>
        <label class="flex items-start gap-2 text-sm"
          ><input v-model="s.require2faAdmins" type="checkbox" class="mt-1" aria-describedby="s-2fa-help" /><span
            >Require two-factor sign-in for admins</span
          ></label
        >
        <p id="s-2fa-help" class="mt-1 text-xs text-slate-500">
          An admin without it is sent to Profile after signing in and can do nothing else until it is on. That includes you, if yours is
          off. Admins who only sign in with Google (no password here) are not asked: Google does its own two-step verification. Everyone can
          turn two-factor on under Profile.
        </p>
      </div>
    </div>
    <div class="card space-y-3 p-4">
      <h2 class="text-sm font-semibold">AI assistants (MCP)</h2>
      <label class="flex items-center gap-2 text-sm"
        ><input v-model="s.apiTokens" type="checkbox" /> Allow personal API tokens and the MCP server at /mcp</label
      >
      <p class="text-xs text-slate-500">
        People create tokens under Profile. A token acts as its owner with their permissions, cannot do admin work, and stops when the
        person is deactivated. Turning this off stops every token at once.
      </p>
    </div>
    <div class="card space-y-3 p-4">
      <h2 class="text-sm font-semibold">Google Sheets feeds</h2>
      <label class="flex items-center gap-2 text-sm"
        ><input v-model="s.sheetFeeds" type="checkbox" /> Allow secret CSV feed links for Google Sheets</label
      >
      <p class="text-xs text-slate-500">
        People create feeds on the Issues page. A feed shows its owner's search to anyone with the link, using the owner's current access.
        Turning this off stops every feed at once.
      </p>
    </div>
    <div v-if="email" class="card space-y-3 p-4">
      <h2 class="text-sm font-semibold">Email</h2>
      <p class="text-sm" :class="email.configured ? 'text-green-700' : 'text-slate-600'">
        {{
          email.configured
            ? `Configured on the server (Postmark). Emails come from ${email.from}.`
            : 'Not configured. Set POSTMARK_SERVER_TOKEN and EMAIL_FROM on the server to send notification and invite emails.'
        }}
      </p>
      <button v-if="email.configured" type="button" class="btn" :disabled="testing" @click="testEmail">Send a test email to me</button>
      <div v-if="email.errors.length">
        <h3 class="label">Recent email errors</h3>
        <ul class="space-y-1 text-xs text-slate-600">
          <li v-for="(e, i) in email.errors" :key="i">
            <span class="text-slate-400">{{ ago(e.createdAt) }}</span> {{ e.kind }}: {{ e.error
            }}<span v-if="e.context"> ({{ e.context }})</span>
          </li>
        </ul>
      </div>
    </div>
    <WorkspaceFonts v-model:settings="s" />
    <ChannelAiSettings v-model:settings="s" />
    <ScheduledJobs v-model:settings="s" />
    <button class="btn btn-primary">Save settings</button>
  </form>
</template>
