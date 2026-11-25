<script setup>
// Profile card: two-factor sign-in (authenticator app codes, RFC 6238) with one-time recovery codes.
// Steps: off -> setup (QR code and secret, confirm with a code) -> recovery codes shown once -> on.
import { ref, computed, watch, onMounted, nextTick } from 'vue';
import { get, post, toast, session, loadMe } from '../api.js';
import { downloadText, copyText } from '../browser.js';
import { qrMatrix, qrPath } from '../qr.js';
import { attempt } from '../composables/useAction.js';

const state = ref(null); // { enabled, enabledAt, hasPassword, recoveryCodesLeft, required }
const setup = ref(null); // { secret, uri } while setting up
const code = ref('');
const error = ref('');
const busy = ref(false);
const codes = ref(null); // recovery codes, shown once
const ask = ref(''); // '' | 'disable' | 'codes': which action is asking for proof
const proofCode = ref('');
const proofPassword = ref('');
const codeInput = ref(null);

async function load() {
  try {
    state.value = await get('/api/me/2fa');
  } catch {
    state.value = null;
  }
}
onMounted(load);
watch(() => session.user?.hasPassword, load); // a first password (Google-only account) makes the setup available

const qr = computed(() => {
  if (!setup.value) return null;
  try {
    const m = qrMatrix(setup.value.uri);
    return { size: m.length + 8, path: qrPath(m, 4) };
  } catch {
    return null; // too long to draw: the secret below still works
  }
});
const secretGroups = computed(() => (setup.value ? setup.value.secret.match(/.{1,4}/g).join(' ') : ''));

async function start() {
  error.value = '';
  busy.value = true;
  await attempt(async () => {
    setup.value = await post('/api/me/2fa/setup');
    code.value = '';
    await nextTick();
    codeInput.value?.focus();
  });
  busy.value = false;
}
async function cancelSetup() {
  setup.value = null;
  error.value = '';
  try {
    await post('/api/me/2fa/disable');
  } catch {
    /* nothing was on */
  }
}
async function confirm() {
  error.value = '';
  busy.value = true;
  try {
    const r = await post('/api/me/2fa/confirm', { code: code.value });
    codes.value = r.recoveryCodes;
    setup.value = null;
    await Promise.all([load(), loadMe()]);
    toast('Two-factor sign-in is on');
  } catch (e) {
    error.value = e.message;
  }
  busy.value = false;
}
function open(what) {
  ask.value = what;
  proofCode.value = proofPassword.value = '';
  error.value = '';
}
async function prove() {
  error.value = '';
  busy.value = true;
  const proof = proofCode.value.trim() ? { code: proofCode.value.trim() } : { password: proofPassword.value };
  try {
    if (ask.value === 'disable') {
      await post('/api/me/2fa/disable', proof);
      codes.value = null;
      toast('Two-factor sign-in is off. Your other sessions were signed out.');
    } else {
      codes.value = (await post('/api/me/2fa/recovery-codes', proof)).recoveryCodes;
      toast('New recovery codes made. The old ones no longer work.');
    }
    ask.value = '';
    await Promise.all([load(), loadMe()]);
  } catch (e) {
    error.value = e.message;
  }
  busy.value = false;
}
const copy = (text, what) => copyText(text, { ok: `${what} copied` });
const download = () =>
  downloadText(
    'tracker-recovery-codes.txt',
    `${session.appName}: two-factor recovery codes for ${session.user.email}\nEach code works once.\n\n${codes.value.join('\n')}\n`,
  );
</script>
<template>
  <section v-if="state" id="two-factor" class="card space-y-3 p-4" aria-labelledby="tf-title">
    <div class="flex flex-wrap items-center gap-2">
      <h2 id="tf-title" class="text-sm font-semibold">Two-factor sign-in</h2>
      <span class="chip" :class="state.enabled ? 'bg-green-100 text-green-800' : 'bg-slate-200 text-slate-700'">{{
        state.enabled ? 'On' : 'Off'
      }}</span>
    </div>
    <p
      v-if="state.required && !state.enabled"
      class="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
      role="alert"
    >
      This workspace requires two-factor sign-in for admins. Turn it on here to use the rest of the tracker.
    </p>

    <!-- recovery codes: shown once, right after turning it on or making new ones -->
    <div v-if="codes" class="space-y-2 rounded-md border border-slate-300 bg-slate-50 p-3" role="group" aria-labelledby="tf-codes-title">
      <h3 id="tf-codes-title" class="text-sm font-semibold">Save your recovery codes</h3>
      <p class="text-sm text-slate-700">
        Each code signs you in once if you do not have your phone. They are shown only now, so keep them somewhere safe, such as a password
        manager.
      </p>
      <ul class="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-sm sm:grid-cols-3" aria-label="Recovery codes">
        <li v-for="c in codes" :key="c">{{ c }}</li>
      </ul>
      <div class="flex flex-wrap gap-2">
        <button type="button" class="btn btn-sm" @click="copy(codes.join('\n'), 'Recovery codes')">Copy codes</button>
        <button type="button" class="btn btn-sm" @click="download">Download as a text file</button>
        <button type="button" class="btn btn-sm btn-primary" @click="codes = null">I have saved them</button>
      </div>
    </div>

    <!-- off -->
    <template v-if="!state.enabled && !setup">
      <p class="text-sm text-slate-600">
        After your password, sign-in also asks for a 6-digit code from an authenticator app on your phone (for example Google Authenticator,
        Microsoft Authenticator or 1Password).
      </p>
      <p v-if="!state.hasPassword" class="text-sm text-slate-600">
        You sign in with Google, which has its own two-step verification. Two-factor here protects password sign-in: set a password above
        first if you want to use it.
      </p>
      <button v-else type="button" class="btn btn-primary" :disabled="busy" @click="start">Turn on two-factor sign-in</button>
    </template>

    <!-- setting up -->
    <form v-if="setup" class="space-y-3" @submit.prevent="confirm">
      <ol class="list-decimal space-y-3 pl-5 text-sm text-slate-700">
        <li>
          Open your authenticator app and scan this QR code.
          <div v-if="qr" class="mt-2 inline-block rounded-md border border-slate-300 bg-white p-1">
            <svg
              :viewBox="`0 0 ${qr.size} ${qr.size}`"
              class="block h-48 w-48 max-w-full"
              role="img"
              aria-label="QR code for your authenticator app"
              shape-rendering="crispEdges"
            >
              <rect :width="qr.size" :height="qr.size" fill="#fff" />
              <path :d="qr.path" fill="#000" />
            </svg>
          </div>
          <div class="mt-2">
            <span id="tf-secret-label" class="label">Cannot scan it? Type this key into the app (time based, 6 digits)</span>
            <div class="flex flex-wrap items-center gap-2">
              <code class="break-all rounded bg-slate-100 px-2 py-1 font-mono text-sm" aria-labelledby="tf-secret-label">{{
                secretGroups
              }}</code>
              <button type="button" class="btn btn-sm" @click="copy(setup.secret, 'Key')">Copy key</button>
            </div>
          </div>
        </li>
        <li>
          <label class="label" for="tf-code">Enter the 6-digit code the app shows</label>
          <input
            id="tf-code"
            ref="codeInput"
            v-model="code"
            class="input w-40 font-mono tracking-widest"
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength="7"
            pattern="[0-9 ]*"
            required
            :aria-invalid="error ? 'true' : undefined"
            aria-describedby="tf-error"
          />
        </li>
      </ol>
      <p v-if="error" id="tf-error" class="text-sm text-red-700" role="alert">{{ error }}</p>
      <div class="flex flex-wrap gap-2">
        <button class="btn btn-primary" :disabled="busy">Turn on</button>
        <button type="button" class="btn" @click="cancelSetup">Cancel</button>
      </div>
    </form>

    <!-- on -->
    <template v-if="state.enabled">
      <p class="text-sm text-slate-600">
        On since {{ new Date(state.enabledAt).toLocaleDateString() }}. Password sign-in asks for a code from your authenticator app.
        <span :class="state.recoveryCodesLeft <= 2 ? 'font-semibold text-red-700' : ''"
          >{{ state.recoveryCodesLeft }} of 10 recovery codes left.</span
        >
      </p>
      <div v-if="!ask" class="flex flex-wrap gap-2">
        <button type="button" class="btn" @click="open('codes')">New recovery codes</button>
        <button type="button" class="btn btn-danger" @click="open('disable')">Turn off two-factor sign-in</button>
      </div>
      <form v-else class="space-y-3 rounded-md border border-slate-300 p-3" @submit.prevent="prove">
        <h3 class="text-sm font-semibold">{{ ask === 'disable' ? 'Turn off two-factor sign-in' : 'Make new recovery codes' }}</h3>
        <p class="text-sm text-slate-600">
          {{
            ask === 'disable' ? 'Confirm it is you. Your other sessions are signed out.' : 'Confirm it is you. The old codes stop working.'
          }}
        </p>
        <div>
          <label class="label" for="tf-proof-code">Code from your authenticator app, or a recovery code</label
          ><input
            id="tf-proof-code"
            v-model="proofCode"
            class="input w-56 max-w-full font-mono"
            autocomplete="one-time-code"
            autocapitalize="none"
            spellcheck="false"
            :required="!proofPassword"
          />
        </div>
        <div>
          <label class="label" for="tf-proof-pw">Or your password</label
          ><input
            id="tf-proof-pw"
            v-model="proofPassword"
            type="password"
            class="input w-56 max-w-full"
            autocomplete="current-password"
            :required="!proofCode"
          />
        </div>
        <p v-if="error" class="text-sm text-red-700" role="alert">{{ error }}</p>
        <div class="flex flex-wrap gap-2">
          <button class="btn" :class="ask === 'disable' ? 'btn-danger' : 'btn-primary'" :disabled="busy">
            {{ ask === 'disable' ? 'Turn off' : 'Make new codes' }}
          </button>
          <button type="button" class="btn" @click="ask = ''">Cancel</button>
        </div>
      </form>
    </template>
  </section>
</template>
