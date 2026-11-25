<script setup>
import { ref } from 'vue';
import { patch, post, session, toast, loadMe } from '../api.js';
import SlackProfile from '../components/SlackProfile.vue';
import EmailProfile from '../components/EmailProfile.vue';
import ReminderProfile from '../components/ReminderProfile.vue';
import ProfilePhoto from '../components/ProfilePhoto.vue';
import TwoFactorProfile from '../components/TwoFactorProfile.vue';
import SessionsProfile from '../components/SessionsProfile.vue';
import { attempt } from '../composables/useAction.js';

const name = ref(session.user.name);
const title = ref(session.user.title || '');
const cur = ref('');
const pw = ref('');
const pw2 = ref('');
const error = ref('');
const sessionsKey = ref(0); // reloads the sessions card after a password change
async function save() {
  await attempt(async () => {
    await patch('/api/me', { name: name.value, title: title.value });
    await loadMe();
    toast('Profile saved');
  });
}
async function changePw() {
  error.value = '';
  if (pw.value !== pw2.value) {
    error.value = 'The new passwords do not match';
    return;
  }
  try {
    await post('/api/me/password', { currentPassword: cur.value, newPassword: pw.value });
    cur.value = pw.value = pw2.value = '';
    await loadMe();
    sessionsKey.value++;
    toast('Password changed. Your other sessions were signed out.');
  } catch (e) {
    error.value = e.message;
  }
}
</script>
<template>
  <div class="mx-auto max-w-2xl space-y-4">
    <h1 class="text-xl font-semibold">Profile</h1>
    <!-- An admin who must turn on two-factor first sees only that card. It is one instance in both cases, so the
         recovery codes it shows stay on screen when the rest of the page appears. -->
    <template v-if="!session.twoFactorRequired">
      <form class="card space-y-3 p-4" @submit.prevent="save">
        <div>
          <label class="label">Email</label>
          <div class="text-sm">
            {{ session.user.email }} <span class="text-slate-500">({{ session.user.role }})</span>
          </div>
        </div>
        <div><label class="label" for="p-name">Name</label><input id="p-name" v-model="name" class="input" required /></div>
        <div><label class="label" for="p-title">Job title</label><input id="p-title" v-model="title" class="input" /></div>
        <button class="btn btn-primary">Save</button>
      </form>
      <ProfilePhoto />
      <form class="card space-y-3 p-4" @submit.prevent="changePw">
        <h2 class="text-sm font-semibold">{{ session.user.hasPassword ? 'Change password' : 'Set a password' }}</h2>
        <div v-if="session.user.hasPassword">
          <label class="label" for="p-cur">Current password</label
          ><input id="p-cur" v-model="cur" type="password" autocomplete="current-password" class="input" required />
        </div>
        <div>
          <label class="label" for="p-new">New password (10 or more characters)</label
          ><input id="p-new" v-model="pw" type="password" minlength="10" autocomplete="new-password" class="input" required />
        </div>
        <div>
          <label class="label" for="p-new2">Repeat new password</label
          ><input id="p-new2" v-model="pw2" type="password" minlength="10" autocomplete="new-password" class="input" required />
        </div>
        <p v-if="error" class="text-sm text-red-700">{{ error }}</p>
        <button class="btn btn-primary">Save password</button>
      </form>
    </template>
    <TwoFactorProfile />
    <template v-if="!session.twoFactorRequired">
      <SessionsProfile :key="sessionsKey" />
      <EmailProfile />
      <SlackProfile />
      <ReminderProfile />
      <section v-if="session.user?.role !== 'guest'" class="card p-4 text-sm">
        <h2 class="text-sm font-semibold">API tokens and AI assistants</h2>
        <p class="mt-1 text-slate-600">
          Tokens, connected apps and the MCP activity log are on the <RouterLink to="/ai" class="link">AI connectors</RouterLink> page.
        </p>
      </section>
    </template>
  </div>
</template>
