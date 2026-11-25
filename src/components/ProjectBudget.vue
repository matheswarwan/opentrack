<script setup>
// Project settings > Budget (project admins): hours or money budget, dates, alert thresholds, per epic or component
// hours budgets, and hourly rates with an effective-from date (person beats role beats the default).
import { ref, reactive, watch, computed } from 'vue';
import { get, put, post, del, toast } from '../api.js';
import { today as localToday } from '../dates.js';
import { attempt } from '../composables/useAction.js';

const props = defineProps({ projectKey: { type: String, required: true }, members: { type: Array, default: () => [] } });
const ROLE_NAMES = {
  admin: 'Project admin',
  member: 'Member',
  viewer: 'Viewer',
  'guest-view': 'Guest: read only',
  'guest-comment': 'Guest: can comment',
  'guest-edit': 'Guest: can create and edit own',
};
const base = () => `/api/projects/${props.projectKey}/budget`;
const exists = ref(false);
const form = reactive({ kind: 'hours', amount: '', currency: 'CAD', startDate: '', endDate: '', thresholds: '80, 100', lines: [] });
const rates = ref([]);
const epics = ref([]);
const components = ref([]);
const today = localToday();
const rate = reactive({ scope: 'default', role: 'member', userId: '', rate: '', effectiveFrom: today });
const exportRange = reactive({ from: '', to: '' });

async function load() {
  await attempt(async () => {
    const [b, e, c] = await Promise.all([
      get(base()),
      get(`/api/issues?project=${props.projectKey}&type=epic&limit=300&sort=key`).catch(() => ({ issues: [] })),
      get(`/api/projects/${props.projectKey}/components`).catch(() => ({ components: [] })),
    ]);
    epics.value = e.issues;
    components.value = c.components;
    rates.value = b.rates || [];
    exists.value = Boolean(b.budget);
    if (b.budget) {
      Object.assign(form, {
        kind: b.budget.kind,
        amount: b.budget.amount,
        currency: b.budget.currency,
        startDate: b.budget.startDate || '',
        endDate: b.budget.endDate || '',
        thresholds: b.budget.thresholds.join(', '),
        lines: (b.burn?.lines || []).map((l) => ({ ...l })),
      });
    }
  });
}
watch(() => props.projectKey, load, { immediate: true });

const targetName = (l) =>
  (l.targetType === 'epic' ? epics.value.find((e) => e.id === l.targetId)?.key : components.value.find((c) => c.id === l.targetId)?.name) ||
  'Removed';
const addLine = () => form.lines.push({ targetType: epics.value.length ? 'epic' : 'component', targetId: '', hours: '' });
const targetsFor = (type) =>
  type === 'epic'
    ? epics.value.map((e) => ({ id: e.id, name: `${e.key} ${e.title}` }))
    : components.value.map((c) => ({ id: c.id, name: c.name }));

async function save() {
  const thresholds = String(form.thresholds)
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(Number);
  await attempt(async () => {
    await put(base(), {
      kind: form.kind,
      amount: Number(form.amount),
      currency: form.currency,
      startDate: form.startDate || null,
      endDate: form.endDate || null,
      thresholds,
      lines: form.lines
        .filter((l) => l.targetId && l.hours !== '')
        .map((l) => ({ targetType: l.targetType, targetId: l.targetId, hours: Number(l.hours) })),
    });
    toast('Budget saved');
    await load();
  });
}
async function remove() {
  if (!confirm('Remove the budget? Rates and work logs stay.')) return;
  await attempt(async () => {
    await del(base());
    exists.value = false;
    toast('Budget removed');
  });
}
async function addRate() {
  await attempt(async () => {
    await post(`${base()}/rates`, {
      scope: rate.scope,
      role: rate.scope === 'role' ? rate.role : undefined,
      userId: rate.scope === 'person' ? rate.userId : undefined,
      rate: Number(rate.rate),
      effectiveFrom: rate.effectiveFrom || undefined,
    });
    rate.rate = '';
    toast('Rate added');
    await load();
  });
}
async function removeRate(r) {
  await attempt(async () => {
    await del(`${base()}/rates/${r.id}`);
    await load();
  });
}
const rateWho = (r) =>
  r.scope === 'default' ? 'Project default' : r.scope === 'role' ? `Role: ${ROLE_NAMES[r.role] || r.role}` : r.user?.name || 'Former user';
const sortedRates = computed(() =>
  [...rates.value].sort((a, b) => rateWho(a).localeCompare(rateWho(b)) || b.effectiveFrom.localeCompare(a.effectiveFrom)),
);
const exportHref = computed(
  () => `${base()}/export.csv?${new URLSearchParams(Object.entries(exportRange).filter(([, v]) => v)).toString()}`,
);
</script>
<template>
  <section class="card space-y-4 p-4" aria-labelledby="pb-title">
    <div>
      <h2 id="pb-title" class="text-sm font-semibold">Budget</h2>
      <p class="text-xs text-slate-500">
        Billable work logged on this project counts against the budget. Project admins see amounts of money; members see hours and
        percentages; guests see nothing unless a status report shares it.
      </p>
    </div>
    <form class="space-y-3" @submit.prevent="save">
      <div class="grid gap-3 sm:grid-cols-3">
        <div>
          <label class="label" for="pb-kind">Budget type</label>
          <select id="pb-kind" v-model="form.kind" class="input">
            <option value="hours">Hours</option>
            <option value="money">Money (hours x rate)</option>
          </select>
        </div>
        <div>
          <label class="label" for="pb-amount">{{ form.kind === 'hours' ? 'Hours' : 'Amount' }}</label>
          <input id="pb-amount" v-model="form.amount" type="number" min="0.01" step="any" class="input" required />
        </div>
        <div v-if="form.kind === 'money'">
          <label class="label" for="pb-cur">Currency</label>
          <input id="pb-cur" v-model="form.currency" class="input uppercase" maxlength="3" pattern="[A-Za-z]{3}" required />
        </div>
        <div>
          <label class="label" for="pb-start">Start date (optional)</label
          ><input id="pb-start" v-model="form.startDate" type="date" class="input" />
        </div>
        <div>
          <label class="label" for="pb-end">End date (optional)</label
          ><input id="pb-end" v-model="form.endDate" type="date" class="input" />
        </div>
        <div>
          <label class="label" for="pb-th">Alert at (% used)</label
          ><input id="pb-th" v-model="form.thresholds" class="input" aria-describedby="pb-th-help" />
        </div>
      </div>
      <p id="pb-th-help" class="text-xs text-slate-500">
        Percentages separated by commas, for example 80, 100. Project admins get one notification per threshold; changing the amount or type
        starts them again.
      </p>

      <div>
        <h3 class="text-sm font-medium">Epic and component budgets (hours, optional)</h3>
        <div v-for="(l, i) in form.lines" :key="i" class="mt-2 flex flex-wrap items-center gap-2">
          <select v-model="l.targetType" class="input w-32" :aria-label="`Line ${i + 1} type`" @change="l.targetId = ''">
            <option value="epic">Epic</option>
            <option value="component">Component</option>
          </select>
          <select v-model="l.targetId" class="input min-w-0 flex-1" :aria-label="`Line ${i + 1} ${l.targetType}`">
            <option value="" disabled>Choose</option>
            <option v-if="l.targetId && !targetsFor(l.targetType).some((t) => t.id === l.targetId)" :value="l.targetId">
              {{ targetName(l) }}
            </option>
            <option v-for="t in targetsFor(l.targetType)" :key="t.id" :value="t.id">{{ t.name }}</option>
          </select>
          <input
            v-model="l.hours"
            type="number"
            min="0.01"
            step="any"
            class="input w-24"
            placeholder="Hours"
            :aria-label="`Line ${i + 1} hours`"
          />
          <button
            type="button"
            class="text-slate-500 hover:text-red-700"
            :aria-label="`Remove line ${i + 1}`"
            @click="form.lines.splice(i, 1)"
          >
            ×
          </button>
        </div>
        <button type="button" class="btn btn-sm mt-2" :disabled="!epics.length && !components.length" @click="addLine">
          Add an epic or component budget
        </button>
      </div>
      <div class="flex flex-wrap gap-2">
        <button class="btn btn-primary">{{ exists ? 'Save budget' : 'Set budget' }}</button>
        <button v-if="exists" type="button" class="btn btn-danger ml-auto" @click="remove">Remove budget</button>
      </div>
    </form>

    <div class="border-t border-slate-100 pt-3">
      <h3 class="text-sm font-medium">Hourly rates</h3>
      <p class="text-xs text-slate-500">
        Cost is billable hours x the rate in effect on the work date. A person's rate beats their role's, which beats the project default.
        Add a new rate with a later effective date to change it without repricing earlier work.
      </p>
      <ul class="mt-2 divide-y divide-slate-100 text-sm">
        <li v-for="r in sortedRates" :key="r.id" class="flex flex-wrap items-center gap-2 py-1.5">
          <span class="min-w-0 flex-1">{{ rateWho(r) }}</span>
          <span class="tabular-nums">{{ r.rate }} {{ form.currency }}/h</span>
          <span class="w-36 text-slate-500">from {{ r.effectiveFrom }}</span>
          <button
            class="text-slate-500 hover:text-red-700"
            :aria-label="`Remove rate for ${rateWho(r)} from ${r.effectiveFrom}`"
            @click="removeRate(r)"
          >
            ×
          </button>
        </li>
        <li v-if="!rates.length" class="py-1.5 text-slate-500">No rates yet. A money budget needs at least a project default rate.</li>
      </ul>
      <form class="mt-2 grid gap-2 sm:grid-cols-5" @submit.prevent="addRate">
        <select v-model="rate.scope" class="input" aria-label="Rate applies to">
          <option value="default">Project default</option>
          <option value="role">A role</option>
          <option value="person">A person</option>
        </select>
        <select v-if="rate.scope === 'role'" v-model="rate.role" class="input" aria-label="Role">
          <option v-for="(name, id) in ROLE_NAMES" :key="id" :value="id">{{ name }}</option>
        </select>
        <select v-else-if="rate.scope === 'person'" v-model="rate.userId" class="input" aria-label="Person" required>
          <option value="" disabled>Choose a person</option>
          <option v-for="m in members" :key="m.userId" :value="m.userId">{{ m.name }}</option>
        </select>
        <span v-else class="hidden sm:block"></span>
        <input
          v-model="rate.rate"
          type="number"
          min="0"
          step="any"
          class="input"
          placeholder="Rate per hour"
          aria-label="Rate per hour"
          required
        />
        <input v-model="rate.effectiveFrom" type="date" class="input" aria-label="Effective from" required />
        <button class="btn">Add rate</button>
      </form>
    </div>

    <div class="border-t border-slate-100 pt-3">
      <h3 class="text-sm font-medium">Billable hours export</h3>
      <p class="text-xs text-slate-500">
        CSV of billable hours and cost by person and week. Leave the dates empty for the budget's dates (or the last 30 days).
      </p>
      <div class="mt-2 flex flex-wrap items-end gap-2">
        <div>
          <label class="label" for="pb-from">From</label><input id="pb-from" v-model="exportRange.from" type="date" class="input" />
        </div>
        <div><label class="label" for="pb-to">To</label><input id="pb-to" v-model="exportRange.to" type="date" class="input" /></div>
        <a class="btn" :href="exportHref" download>Download CSV</a>
      </div>
    </div>
  </section>
</template>
