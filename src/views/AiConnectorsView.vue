<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { get, post, del, toast, session, users as loadUsers } from '../api.js';
import { copyText } from '../browser.js';
import { ago, fmtDate, fmtDateTime } from '../meta.js';
import { projectList } from '../projects.js';
import { attempt } from '../composables/useAction.js';
import { useLoad } from '../composables/useLoad.js';
import LoadState from '../components/LoadState.vue';

const url = `${location.origin}/mcp`;
const TOOLS =
  'list_projects, my_work, search_issues, get_issue, create_issue, update_issue, add_comment, log_work, list_sprints, list_releases, list_raid, project_report, add_link, list_users';

// ---- tokens ----
const tokens = ref([]);
const enabled = ref(true);
const apps = ref([]);
const projects = ref([]);
const name = ref('Claude Code');
const days = ref('90');
const scope = ref('all');
const picked = ref([]);
const fresh = ref(null);
const creating = ref(false);

const { error: loadError, reload: load } = useLoad(async () => {
  const [r, a] = await Promise.all([get('/api/me/tokens'), get('/api/me/connected-apps')]);
  tokens.value = r.tokens;
  enabled.value = r.enabled;
  apps.value = a.apps;
  return true;
});
onMounted(() => {
  projectList()
    .then((list) => {
      projects.value = list;
    })
    .catch(() => {}); // only for the "these projects" picker
  loadActivity();
});

async function create() {
  if (scope.value === 'projects' && !picked.value.length) {
    toast('Choose at least one project', 'error');
    return;
  }
  creating.value = true;
  await attempt(async () => {
    fresh.value = await post('/api/me/tokens', {
      name: name.value,
      expiresInDays: days.value ? Number(days.value) : undefined,
      projectIds: scope.value === 'projects' ? picked.value : undefined,
    });
    await load();
  });
  creating.value = false;
}
async function revoke(t) {
  if (!confirm(`Revoke "${t.name}"? Anything using it stops working.`)) return;
  await del(`/api/me/tokens/${t.id}`);
  await load();
}
async function revokeApp(a) {
  if (!confirm(`Remove access for "${a.clientName}"? It has to be connected again to use the tracker.`)) return;
  await del(`/api/me/connected-apps/${encodeURIComponent(a.clientId)}`);
  await load();
}
const reads = (t) => (t.scope === 'all' ? 'All projects' : t.projects.map((p) => p.key || p.name).join(', '));
const statusCls = { active: 'bg-green-50 text-green-800', revoked: 'bg-slate-100 text-slate-500', expired: 'bg-amber-50 text-amber-800' };

const copy = (text) => copyText(text);

// ---- client instructions ----
const tok = computed(() => fresh.value?.token || '<your token>');
const json = (o) => JSON.stringify(o, null, 2);
const tab = ref('claude-code');
const clients = computed(() => [
  {
    id: 'claude-code',
    label: 'Claude Code',
    steps: [
      'Run this in a terminal. Add --scope project to share the server (not the token) with a repo, or --scope user to use it in every project.',
    ],
    snippet: `claude mcp add --transport http opentrack ${url} --header "Authorization: Bearer ${tok.value}"`,
    after: 'Check it with: claude mcp list',
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    steps: [
      'Open Settings > Connectors and choose Add custom connector.',
      'Paste the URL below. Leave the OAuth fields empty.',
      'Choose Connect, sign in to the tracker if asked, and allow access. No token is needed.',
      'On Team and Enterprise plans an owner may have to add the connector for the organization first.',
    ],
    snippet: url,
    oauth: true,
  },
  {
    id: 'claude-ai',
    label: 'Claude.ai',
    steps: [
      'Open Settings > Connectors and choose Add custom connector.',
      'Paste the URL below and choose Add, then Connect. You sign in to the tracker and allow access. No token is needed.',
      'In a chat, turn the connector on from the tools menu.',
      'On Team and Enterprise plans an owner may have to add the connector for the organization first.',
    ],
    snippet: url,
    oauth: true,
  },
  {
    id: 'vscode',
    label: 'VS Code (Copilot)',
    steps: [
      'Save this as .vscode/mcp.json in your workspace (or run MCP: Open User Configuration for all workspaces).',
      'VS Code asks for the token the first time and stores it securely, so the file holds no secret.',
      'Open Copilot Chat, switch to Agent mode, and turn on the opentrack tools.',
    ],
    snippet: json({
      inputs: [{ type: 'promptString', id: 'opentrack-token', description: 'Opentrack API token', password: true }],
      servers: { opentrack: { type: 'http', url, headers: { Authorization: 'Bearer ${input:opentrack-token}' } } },
    }),
  },
  {
    id: 'cursor',
    label: 'Cursor',
    steps: [
      'Add this to ~/.cursor/mcp.json (all projects) or .cursor/mcp.json in a project. Do not commit a file that holds the token.',
      'Check that the server shows as enabled under Cursor Settings > MCP (look for Tools and MCP).',
    ],
    snippet: json({ mcpServers: { opentrack: { url, headers: { Authorization: `Bearer ${tok.value}` } } } }),
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    steps: [
      'Add this to ~/.codeium/windsurf/mcp_config.json (or open it from the Cascade panel: look for the MCP servers settings and View raw config).',
      'Refresh the MCP servers in Cascade. If your version does not accept headers, use the setup from the Other clients tab.',
    ],
    snippet: json({ mcpServers: { opentrack: { serverUrl: url, headers: { Authorization: `Bearer ${tok.value}` } } } }),
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    steps: [
      'Add this to ~/.gemini/settings.json (or .gemini/settings.json in a project).',
      'Start gemini and run /mcp to check that the tools are listed.',
    ],
    snippet: json({ mcpServers: { opentrack: { httpUrl: url, headers: { Authorization: `Bearer ${tok.value}` } } } }),
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    steps: [
      'ChatGPT connects with OAuth, so no token is needed.',
      'In Settings, look for Apps and Connectors > Advanced settings and turn on Developer mode. On Business and Enterprise plans an admin may have to allow this first.',
      'Create a connector (look for Create or Add app), paste the URL below, and choose OAuth as the authentication.',
      'Sign in to the tracker and allow access. In a chat, pick the connector from the tools menu.',
      'The menu names change often. If you cannot find them, search the ChatGPT help for "developer mode" and "MCP".',
    ],
    snippet: url,
    oauth: true,
  },
  {
    id: 'grok',
    label: 'Grok',
    steps: [
      'We could not confirm that the Grok app (grok.com or the mobile apps) lets you add your own MCP server, so there are no steps for it here.',
      'Developers calling the xAI API can give Grok a remote MCP server as a tool. Check the xAI API documentation for the current format and pass the URL below with an Authorization: Bearer header holding your token.',
    ],
    snippet: url,
  },
  {
    id: 'other',
    label: 'Other clients',
    steps: [
      'Clients that support remote MCP servers over Streamable HTTP with headers: use the URL and send the header Authorization: Bearer <token>.',
      'Clients that only run local (stdio) servers: use mcp-remote through npx (needs Node.js). This is the usual mcpServers format; the header value is passed through an environment variable.',
    ],
    snippet: json({
      mcpServers: {
        opentrack: {
          command: 'npx',
          args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${AUTH_HEADER}'],
          env: { AUTH_HEADER: `Bearer ${tok.value}` },
        },
      },
    }),
  },
]);
const current = computed(() => clients.value.find((x) => x.id === tab.value));

// ---- activity ----
const isAdmin = computed(() => session.user?.role === 'admin');
const calls = ref([]);
const everyone = ref(false);
const who = ref('');
const result = ref('');
const people = ref([]);
async function loadActivity() {
  await attempt(async () => {
    const q = new URLSearchParams();
    if (everyone.value) q.set('all', '1');
    if (everyone.value && who.value) q.set('user', who.value);
    if (result.value) q.set('result', result.value);
    calls.value = (await get(`/api/mcp/activity?${q}`)).calls;
  });
}
watch([everyone, who, result], loadActivity);
watch(everyone, async (on) => {
  if (on && !people.value.length)
    await attempt(async () => {
      people.value = await loadUsers();
    });
  if (!on) who.value = '';
});
const resultCls = { ok: 'bg-green-50 text-green-800', error: 'bg-amber-50 text-amber-800', rejected: 'bg-red-50 text-red-800' };
</script>

<template>
  <div class="mx-auto max-w-5xl space-y-4">
    <div>
      <h1 class="text-xl font-semibold">AI connectors</h1>
      <p class="mt-1 text-sm text-slate-600">
        AI assistants such as Claude, Copilot and ChatGPT can search, create and update issues for you through the tracker's MCP server at
        <code class="text-xs">{{ url }}</code>. They act as you, with your permissions. Treat a token like a password.
      </p>
    </div>
    <LoadState v-if="loadError" :error="loadError" @retry="load" />
    <p v-else-if="!enabled" class="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
      An admin has turned off API tokens and the MCP server.
    </p>

    <template v-else>
      <!-- create -->
      <section class="card space-y-3 p-4">
        <h2 class="text-sm font-semibold">Create a token</h2>
        <form class="space-y-3" @submit.prevent="create">
          <div class="flex flex-wrap items-end gap-3">
            <div>
              <label class="label" for="tk-name">Name</label
              ><input id="tk-name" v-model="name" class="input w-56" required maxlength="60" />
            </div>
            <div>
              <label class="label" for="tk-days">Expires</label>
              <select id="tk-days" v-model="days" class="input w-36">
                <option value="30">In 30 days</option>
                <option value="90">In 90 days</option>
                <option value="365">In a year</option>
                <option value="">Never</option>
              </select>
            </div>
          </div>
          <fieldset>
            <legend class="label">What it can read and change</legend>
            <div class="flex flex-wrap gap-4 text-sm">
              <label class="flex items-center gap-2"><input v-model="scope" type="radio" value="all" /> All projects you can see</label>
              <label class="flex items-center gap-2"><input v-model="scope" type="radio" value="projects" /> Specific projects</label>
            </div>
            <div
              v-if="scope === 'projects'"
              class="mt-2 grid max-h-48 grid-cols-1 gap-1 overflow-auto rounded-md border border-slate-200 p-2 text-sm sm:grid-cols-2"
            >
              <label v-for="p in projects" :key="p.id" class="flex items-center gap-2">
                <input v-model="picked" type="checkbox" :value="p.id" /> <span class="font-mono text-xs text-slate-500">{{ p.key }}</span>
                {{ p.name }}
              </label>
              <p v-if="!projects.length" class="text-slate-500">No projects.</p>
            </div>
            <p v-if="scope === 'projects'" class="mt-1 text-xs text-slate-500">The token cannot see other projects, or create new ones.</p>
          </fieldset>
          <button class="btn btn-primary" :disabled="creating">Create token</button>
        </form>
        <div v-if="fresh" class="space-y-2 rounded-md border border-green-200 bg-green-50 p-3 text-sm">
          <p class="font-medium">Copy your token now. It is not shown again. The setup steps below now include it.</p>
          <div class="flex gap-2">
            <input :value="fresh.token" class="input font-mono text-xs" readonly @focus="$event.target.select()" /><button
              class="btn"
              @click="copy(fresh.token)"
            >
              Copy
            </button>
          </div>
        </div>
      </section>

      <!-- list -->
      <section class="card p-4">
        <h2 class="mb-2 text-sm font-semibold">Your tokens</h2>
        <p v-if="!tokens.length" class="text-sm text-slate-500">No tokens yet.</p>
        <div v-else class="overflow-x-auto">
          <table class="w-full text-left text-sm">
            <thead class="text-xs text-slate-500">
              <tr>
                <th class="py-1 pr-3">Name</th>
                <th class="pr-3">Prefix</th>
                <th class="pr-3">Reads</th>
                <th class="pr-3">Created</th>
                <th class="pr-3">Last used</th>
                <th class="pr-3">Expires</th>
                <th class="pr-3">Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="t in tokens" :key="t.id" :class="t.status !== 'active' ? 'text-slate-400' : ''">
                <td class="py-1.5 pr-3 font-medium">{{ t.name }}</td>
                <td class="pr-3">
                  <code class="text-xs">{{ t.prefix }}…</code>
                </td>
                <td class="pr-3">{{ reads(t) }}</td>
                <td class="pr-3 whitespace-nowrap">{{ fmtDate(t.createdAt) }}</td>
                <td class="pr-3 whitespace-nowrap">{{ t.lastUsedAt ? ago(t.lastUsedAt) : 'Never' }}</td>
                <td class="pr-3 whitespace-nowrap">{{ t.expiresAt ? fmtDate(t.expiresAt) : 'Never' }}</td>
                <td class="pr-3">
                  <span class="chip" :class="statusCls[t.status]">{{ t.status }}</span>
                </td>
                <td class="text-right">
                  <button v-if="t.status === 'active'" class="btn btn-sm btn-danger" @click="revoke(t)">Revoke</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- clients -->
      <section class="card space-y-3 p-4">
        <h2 class="text-sm font-semibold">Connect from your client</h2>
        <div class="flex flex-wrap gap-1" role="tablist">
          <button
            v-for="cl in clients"
            :key="cl.id"
            type="button"
            role="tab"
            :aria-selected="tab === cl.id"
            class="btn btn-sm"
            :class="tab === cl.id ? 'btn-primary' : ''"
            @click="tab = cl.id"
          >
            {{ cl.label }}
          </button>
        </div>
        <div v-if="current" class="space-y-2 text-sm" role="tabpanel">
          <p v-if="current.oauth" class="rounded bg-blue-50 px-3 py-2 text-blue-900">
            Uses sign-in (OAuth): add the URL only. The connection can reach every project you can see.
          </p>
          <ol class="list-decimal space-y-1 pl-5">
            <li v-for="(st, i) in current.steps" :key="i">{{ st }}</li>
          </ol>
          <div class="flex gap-2">
            <pre class="flex-1 overflow-x-auto whitespace-pre-wrap break-all rounded bg-slate-900 p-2 text-xs text-slate-100">{{
              current.snippet
            }}</pre>
            <button class="btn btn-sm self-start" @click="copy(current.snippet)">Copy</button>
          </div>
          <p v-if="current.after" class="text-xs text-slate-500">{{ current.after }}</p>
          <p v-if="!current.oauth && !fresh && current.snippet.includes('<your token>')" class="text-xs text-slate-500">
            Create a token above and it is filled in here.
          </p>
        </div>
        <p class="text-xs text-slate-500">
          Tools: {{ TOOLS }}. Then ask things like "what is assigned to me?" or "move WEB-12 to Done and comment that it shipped".
        </p>
      </section>

      <!-- connected apps -->
      <section class="card space-y-2 p-4">
        <h2 class="text-sm font-semibold">Connected apps</h2>
        <p v-if="!apps.length" class="text-sm text-slate-500">No apps connected. Apps you allow through a connector (OAuth) show here.</p>
        <div v-else class="divide-y divide-slate-100 rounded-md border border-slate-200">
          <div v-for="a in apps" :key="a.clientId" class="flex items-center gap-3 px-3 py-2 text-sm">
            <span class="font-medium">{{ a.clientName }}</span>
            <span class="text-xs text-slate-500"
              >allowed {{ fmtDate(a.authorizedAt) }} · {{ a.lastUsedAt ? `used ${ago(a.lastUsedAt)}` : 'not used yet' }} · all
              projects</span
            >
            <button class="btn btn-sm btn-danger ml-auto" @click="revokeApp(a)">Revoke</button>
          </div>
        </div>
      </section>
    </template>

    <!-- activity -->
    <section class="card space-y-2 p-4">
      <div class="flex flex-wrap items-center gap-3">
        <h2 class="text-sm font-semibold">Activity</h2>
        <label v-if="isAdmin" class="flex items-center gap-2 text-sm"><input v-model="everyone" type="checkbox" /> Everyone</label>
        <select v-if="isAdmin && everyone" v-model="who" class="input w-48" aria-label="Person">
          <option value="">All people</option>
          <option v-for="u in people" :key="u.id" :value="u.id">{{ u.name }}</option>
        </select>
        <select v-model="result" class="input w-36" aria-label="Result">
          <option value="">All results</option>
          <option value="ok">OK</option>
          <option value="error">Error</option>
          <option value="rejected">Rejected</option>
        </select>
        <button class="btn btn-sm ml-auto" @click="loadActivity">Refresh</button>
      </div>
      <p class="text-xs text-slate-500">Every MCP tool call is logged, and so is every refused token. Kept for 90 days.</p>
      <p v-if="!calls.length" class="text-sm text-slate-500">No calls yet.</p>
      <div v-else class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="text-xs text-slate-500">
            <tr>
              <th class="py-1 pr-3">When</th>
              <th v-if="everyone" class="pr-3">Who</th>
              <th class="pr-3">Tool</th>
              <th class="pr-3">Token or app</th>
              <th class="pr-3">Result</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            <tr v-for="r in calls" :key="r.id">
              <td class="py-1.5 pr-3 whitespace-nowrap" :title="fmtDateTime(r.createdAt)">{{ ago(r.createdAt) }}</td>
              <td v-if="everyone" class="pr-3">{{ r.user ? r.user.name : 'Unknown' }}</td>
              <td class="pr-3">
                <code v-if="r.tool" class="text-xs">{{ r.tool }}</code><span v-else class="text-slate-400">none</span>
              </td>
              <td class="pr-3">
                {{ r.clientName || '' }} <code v-if="r.tokenPrefix" class="text-xs text-slate-500">{{ r.tokenPrefix }}…</code>
              </td>
              <td class="pr-3">
                <span class="chip" :class="resultCls[r.result]">{{ r.result }}</span>
                <span v-if="r.error" class="text-xs text-slate-500">{{ r.error }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
