<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { post, loadMe } from '../api.js';
import AuthCard from '../components/AuthCard.vue';

const router = useRouter();
const f = ref({ token: '', name: '', email: '', password: '' });
const error = ref('');
const busy = ref(false);
async function submit() {
  busy.value = true;
  error.value = '';
  try {
    await post('/api/auth/setup', f.value);
    await loadMe();
    router.replace('/admin/users');
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <AuthCard title="Create the first admin">
    <p class="mb-3 text-sm text-slate-600">This works once, while there are no users. You need the setup token set on the server.</p>
    <form class="space-y-3" @submit.prevent="submit">
      <div>
        <label class="label" for="token">Setup token</label><input id="token" v-model="f.token" type="password" class="input" required />
      </div>
      <div><label class="label" for="name">Your name</label><input id="name" v-model="f.name" class="input" required /></div>
      <div><label class="label" for="email">Email</label><input id="email" v-model="f.email" type="email" class="input" required /></div>
      <div>
        <label class="label" for="pw">Password (10 or more characters)</label
        ><input id="pw" v-model="f.password" type="password" minlength="10" autocomplete="new-password" class="input" required />
      </div>
      <button class="btn btn-primary w-full py-2" :disabled="busy">Create admin</button>
    </form>
    <p v-if="error" class="mt-3 text-sm text-red-700">{{ error }}</p>
  </AuthCard>
</template>
