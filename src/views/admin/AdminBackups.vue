<script setup>
// Admin > Backups: download a full JSON backup, and the state of the daily automatic copy.
import { ref, computed } from 'vue';
import { get, post, toast } from '../../api.js';
import { ago, fmtDateTime } from '../../meta.js';
import { attempt } from '../../composables/useAction.js';
import { useLoad } from '../../composables/useLoad.js';
import LoadState from '../../components/LoadState.vue';
import { plural } from '../../plural.js';

const withFiles = ref(false);
const running = ref(false);
const { data: s, loading, error: loadError, reload: load } = useLoad(() => get('/api/admin/backups'));

const size = (n) =>
  n === null || n === undefined ? '' : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
const filesTooBig = computed(() => s.value && s.value.files.bytes > s.value.files.limit);
const href = computed(() => `/api/admin/backup${withFiles.value && !filesTooBig.value ? '?files=1' : ''}`);
function downloaded() {
  toast('Backup download started');
  setTimeout(load, 3000);
}
async function runNow() {
  running.value = true;
  await attempt(async () => {
    const r = await post('/api/admin/jobs/run', { name: 'backup' });
    toast(r.status === 'error' ? `Backup failed: ${r.error}` : r.result?.summary || 'Done', r.status === 'error' ? 'error' : 'ok');
  });
  running.value = false;
  load();
}
const KIND = { download: 'Download', webhook: 'Webhook', gcs: 'Cloud Storage', github: 'GitHub' };
// Backup to GitHub (server/lib/githubBackup.js): committed every 6 hours and on demand
const pushing = ref(false);
async function pushGithub() {
  pushing.value = true;
  await attempt(async () => {
    const r = await post('/api/admin/backups/github');
    toast(`Committed ${size(r.size)} to ${r.destination}`);
  });
  pushing.value = false;
  load();
}
</script>

<template>
  <LoadState v-if="!s" :loading="loading" :error="loadError" card :rows="4" @retry="load" />
  <div v-else class="max-w-3xl space-y-4">
    <div class="card space-y-3 p-4">
      <h2 class="text-sm font-semibold">Download a full backup</h2>
      <p class="text-sm text-slate-600">
        One JSON file with everything needed to rebuild the workspace: people (without passwords or tokens), projects, members, workflows,
        sprints, issues (including the Trash), labels, comments, history, links, watchers, work logs, templates, saved filters, reports,
        dashboards and settings. Attachments are listed; their files are added only if you tick the box. Secrets (passwords, sessions, API
        and feed tokens, the Slack token) are never included. The format is described in docs/backup-format.md, and
        scripts/restore-backup.mjs loads a file into a new database.
      </p>
      <label class="flex items-center gap-2 text-sm" :class="filesTooBig ? 'text-slate-400' : ''">
        <input v-model="withFiles" type="checkbox" :disabled="filesTooBig" />
        Include attached files ({{ s.files.count }} {{ plural(s.files.count, 'file') }}, {{ size(s.files.bytes) || '0 KB' }})
      </label>
      <p v-if="filesTooBig" class="text-xs text-slate-500">
        Files total more than {{ size(s.files.limit) }}, too much for one download. The backup still lists every attachment.
      </p>
      <a class="btn btn-primary" :href="href" download @click="downloaded">Download backup</a>
    </div>

    <div class="card space-y-3 p-4">
      <h2 class="text-sm font-semibold">Automatic daily copy</h2>
      <template v-if="s.destination">
        <p class="text-sm text-green-700">Configured: every day the backup (without file bytes) is sent to {{ s.destination.label }}.</p>
      </template>
      <p v-else class="text-sm text-slate-600">
        Not configured. To keep a daily copy somewhere else, set BACKUP_WEBHOOK_URL (and BACKUP_WEBHOOK_SECRET, sent as the X-Backup-Secret
        header) or GCS_BACKUP_BUCKET on the server. Until then, download a backup here from time to time.
      </p>
      <dl v-if="s.job" class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-slate-600">
        <dt class="text-slate-400">Schedule</dt>
        <dd>
          {{
            s.job.enabled
              ? `Every day after ${String(s.job.hour).padStart(2, '0')}:00 (Settings > Scheduled jobs)`
              : 'Off (Settings > Scheduled jobs)'
          }}
        </dd>
        <dt class="text-slate-400">Last run</dt>
        <dd>{{ s.job.lastRunOn ? `${s.job.lastRunOn}${s.job.startedAt ? ` (${ago(s.job.startedAt)})` : ''}` : 'Never' }}</dd>
        <template v-if="s.job.result?.summary"
          ><dt class="text-slate-400">Result</dt>
          <dd :class="s.job.status === 'error' ? 'text-red-700' : ''">{{ s.job.result.summary }}</dd></template
        >
      </dl>
      <button v-if="s.destination" type="button" class="btn" :disabled="running" @click="runNow">Send a copy now</button>
    </div>

    <div class="card space-y-3 p-4" data-github-backup>
      <h2 class="text-sm font-semibold">Backup to GitHub</h2>
      <template v-if="s.github?.ready">
        <p class="text-sm text-green-700">
          Configured: every 6 hours the full backup (without file bytes, passwords or tokens) is committed to
          <strong>{{ s.github.repo }}</strong> ({{ s.github.path }} on {{ s.github.branch }}). Each commit is a version, so the repository's
          history keeps every copy.
        </p>
        <dl v-if="s.githubJob" class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-slate-600">
          <dt class="text-slate-500">Last run</dt>
          <dd>{{ s.githubJob.startedAt ? ago(s.githubJob.startedAt) : 'Not yet' }}</dd>
          <template v-if="s.githubJob.result?.summary"
            ><dt class="text-slate-500">Result</dt>
            <dd :class="s.githubJob.status === 'error' ? 'text-red-700' : ''">{{ s.githubJob.result.summary }}</dd></template
          >
        </dl>
        <button type="button" class="btn" :disabled="pushing" @click="pushGithub">
          {{ pushing ? 'Committing…' : 'Back up to GitHub now' }}
        </button>
      </template>
      <p v-else-if="s.github" class="text-sm text-red-700">
        {{ !s.github.valid ? 'GITHUB_BACKUP_REPO must look like owner/repo.' : 'GITHUB_BACKUP_TOKEN is not set on the server.' }}
      </p>
      <div v-else class="space-y-1 text-sm text-slate-600">
        <p>Not set up. To keep a copy in a private GitHub repository (restorable after a server crash):</p>
        <ol class="list-decimal space-y-0.5 pl-5">
          <li>Create a private repository, for example <code>tracker-backups</code>.</li>
          <li>Create a fine-grained personal access token for that repository only, with Contents: Read and write.</li>
          <li>
            On the server set GITHUB_BACKUP_REPO (owner/repo) and the secret GITHUB_BACKUP_TOKEN; optional GITHUB_BACKUP_BRANCH and
            GITHUB_BACKUP_PATH.
          </li>
        </ol>
        <p>
          Restore: <code>node scripts/restore-backup.mjs --github owner/repo --d1-sql restore.sql</code> (or --sqlite / --postgres); see
          docs/backup-format.md.
        </p>
      </div>
    </div>

    <div class="card">
      <h2 class="border-b border-slate-200 px-4 py-2 text-sm font-semibold">Recent backups</h2>
      <p v-if="!s.runs.length" class="px-4 py-6 text-center text-sm text-slate-500">No backups yet.</p>
      <ul v-else class="divide-y divide-slate-100 text-sm">
        <li v-for="r in s.runs" :key="r.id" class="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2">
          <span class="text-slate-600" :title="fmtDateTime(r.startedAt)">{{ fmtDateTime(r.startedAt) }}</span>
          <span
            >{{ KIND[r.kind] || r.kind }}<span v-if="r.by" class="text-slate-500"> by {{ r.by }}</span></span
          >
          <span v-if="r.status === 'ok'" class="text-green-700"
            >OK<span v-if="r.size" class="text-slate-500"
              >, {{ size(r.size) }}<span v-if="r.rows">, {{ r.rows }} rows</span></span
            ></span
          >
          <span v-else-if="r.status === 'running'" class="text-slate-500">Running or stopped</span>
          <span v-else class="break-words text-red-700">Failed: {{ r.error }}</span>
          <span v-if="r.destination && r.kind !== 'download'" class="w-full text-xs text-slate-500">{{ r.destination }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>
