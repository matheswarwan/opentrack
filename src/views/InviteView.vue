<script setup>
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { get, post, loadMe, pendingSignIn } from '../api.js';
import AuthCard from '../components/AuthCard.vue';

const route = useRoute();
const router = useRouter();
const info = ref(null);
const name = ref('');
const pw = ref('');
const pw2 = ref('');
const error = ref('');
const busy = ref(false);
onMounted(async () => {
  try {
    info.value = await get(`/api/auth/invite/${route.params.token}`);
    name.value = info.value.name;
  } catch (e) {
    error.value = e.message;
  }
});
async function submit() {
  if (pw.value !== pw2.value) {
    error.value = 'The passwords do not match';
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const r = await post(`/api/auth/invite/${route.params.token}`, { name: name.value, password: pw.value });
    if (r.twoFactor) {
      // the password is saved; two-factor sign-in still asks for the code
      pendingSignIn.token = r.pendingToken;
      router.replace('/login');
      return;
    }
    await loadMe();
    router.replace('/');
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <AuthCard title="Set up your account">
    <template v-if="info">
      <p class="mb-3 text-sm text-slate-600">
        Signing in as <strong>{{ info.email }}</strong>.
      </p>
      <a v-if="info.google" href="/auth/google" class="btn mb-4 w-full py-2">Use Google sign-in instead</a>
      <form class="space-y-3" @submit.prevent="submit">
        <div><label class="label" for="name">Name</label><input id="name" v-model="name" class="input" required /></div>
        <div>
          <label class="label" for="pw">Password (10 or more characters)</label
          ><input id="pw" v-model="pw" type="password" minlength="10" autocomplete="new-password" class="input" required />
        </div>
        <div>
          <label class="label" for="pw2">Repeat password</label
          ><input id="pw2" v-model="pw2" type="password" minlength="10" autocomplete="new-password" class="input" required />
        </div>
        <button class="btn btn-primary w-full py-2" :disabled="busy">Save and sign in</button>
      </form>
    </template>
    <p v-if="error" class="mt-3 text-sm text-red-700">{{ error }}</p>
    <RouterLink v-if="error && !info" to="/login" class="link mt-3 block text-sm">Go to sign in</RouterLink>
  </AuthCard>
</template>
