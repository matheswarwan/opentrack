<script setup>
import { ref, onMounted, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { get, post, loadMe, session, toast, pendingSignIn } from '../api.js';
import AuthCard from '../components/AuthCard.vue';

const route = useRoute();
const router = useRouter();
const cfg = ref(null);
const email = ref('');
const password = ref('');
const error = ref(route.query.error || '');
const busy = ref(false);
// Second step for people with two-factor sign-in: the password was right, the server gave a pending token
// (5 minutes, no session yet) and now wants a code. An accepted invite or reset link can land here too.
const pending = ref(pendingSignIn.token || '');
pendingSignIn.token = '';
const code = ref('');
const codeInput = ref(null);
const next = (() => {
  const n = String(route.query.next || '/');
  return n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : '/';
})();
// Server pages (OAuth consent for AI assistant connectors) need a full page load.
function goNext() {
  if (next.startsWith('/oauth/')) window.location.assign(next);
  else router.replace(next);
}
const googleHref = next !== '/' ? `/auth/google?next=${encodeURIComponent(next)}` : '/auth/google';
onMounted(async () => {
  cfg.value = await get('/api/auth/config');
  session.appName = cfg.value.appName;
  if (cfg.value.needsSetup) router.replace('/setup');
  else if (session.user) goNext();
  else if (pending.value) codeInput.value?.focus();
});
async function submit() {
  busy.value = true;
  error.value = '';
  try {
    const r = await post('/api/auth/login', { email: email.value, password: password.value });
    if (r.twoFactor) {
      pending.value = r.pendingToken;
      password.value = '';
      code.value = '';
      await nextTick();
      codeInput.value?.focus();
      return;
    }
    await loadMe();
    goNext();
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
async function verify() {
  busy.value = true;
  error.value = '';
  try {
    const r = await post('/api/auth/login/2fa', { pendingToken: pending.value, code: code.value });
    if (r.recoveryCodesLeft !== undefined)
      toast(`Recovery code used. ${r.recoveryCodesLeft} left: make new ones under Profile if you are running low.`, 'warn');
    pending.value = '';
    await loadMe();
    goNext();
  } catch (e) {
    error.value = e.message;
    code.value = '';
    if (e.data?.code === 'challenge_expired') pending.value = '';
    else codeInput.value?.focus();
  } finally {
    busy.value = false;
  }
}
async function startDemo() {
  busy.value = true;
  error.value = '';
  try {
    await post('/api/auth/demo', {});
    await loadMe();
    goNext();
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
function startAgain() {
  pending.value = '';
  code.value = '';
  error.value = '';
}
</script>
<template>
  <AuthCard :title="pending ? 'Enter your code' : 'Sign in'">
    <form v-if="pending" class="space-y-3" @submit.prevent="verify">
      <p class="text-sm text-slate-600">Open your authenticator app and enter the 6-digit code for {{ session.appName }}.</p>
      <div>
        <label class="label" for="code">Code from your authenticator app, or a recovery code</label>
        <input
          id="code"
          ref="codeInput"
          v-model="code"
          class="input font-mono tracking-widest"
          inputmode="text"
          autocomplete="one-time-code"
          autocapitalize="none"
          spellcheck="false"
          maxlength="20"
          required
          aria-describedby="code-help"
        />
        <p id="code-help" class="mt-1 text-xs text-slate-600">No phone? Use one of the recovery codes you saved. Each works once.</p>
      </div>
      <button class="btn btn-primary w-full py-2" :disabled="busy">Verify and sign in</button>
      <button type="button" class="btn btn-ghost w-full" @click="startAgain">Start again with another account</button>
    </form>
    <template v-else>
      <div v-if="cfg?.demo" class="mb-4 space-y-2 rounded-lg border border-blue-200 bg-blue-50 p-3" data-demo>
        <p class="text-sm text-slate-700">This is a public demo. Look around with every feature turned on; admin settings are read-only.</p>
        <button type="button" class="btn btn-primary w-full py-2" :disabled="busy" @click="startDemo">Explore the demo</button>
      </div>
      <a v-if="cfg?.google" :href="googleHref" class="btn mb-4 w-full py-2">
        <svg viewBox="0 0 48 48" class="h-4 w-4" aria-hidden="true">
          <path
            fill="#FFC107"
            d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"
          />
          <path
            fill="#FF3D00"
            d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
          />
          <path
            fill="#4CAF50"
            d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"
          />
          <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
        </svg>
        Sign in with Google
      </a>
      <form v-if="!cfg || cfg.passwordLogin" class="space-y-3" @submit.prevent="submit">
        <div>
          <label class="label" for="email">Email</label
          ><input id="email" v-model="email" type="email" autocomplete="username" class="input" required />
        </div>
        <div>
          <label class="label" for="password">Password</label
          ><input id="password" v-model="password" type="password" autocomplete="current-password" class="input" required />
        </div>
        <button class="btn btn-primary w-full py-2" :disabled="busy">Sign in</button>
      </form>
    </template>
    <p v-if="error" class="mt-3 text-sm text-red-700" role="alert">{{ error }}</p>
    <p class="mt-4 text-xs text-slate-500">
      {{
        pending
          ? 'Lost your phone and your recovery codes? Ask an admin to reset your two-factor sign-in.'
          : 'No account or forgot your password? Ask an admin for a link.'
      }}
    </p>
  </AuthCard>
</template>
