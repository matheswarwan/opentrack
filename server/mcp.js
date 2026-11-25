// MCP server (Model Context Protocol, Streamable HTTP transport, JSON responses).
// POST /mcp with JSON-RPC 2.0. Auth: `Authorization: Bearer otk_...` (a personal API token, or an
// access token from the OAuth flow in routes/oauth.js);
// every tool runs as that person through the normal API, so the same permissions apply.
import { tokenUser, bearerToken } from './lib/session.js';
import { publicOrigin } from './lib/http.js';
import { uuid, now, sha256 } from './lib/crypto.js';
import { getSettings } from './lib/settings.js';
import { applyTitlePrefix, SUBTASK_PARENTS } from './lib/issues/templates.js';
import { TYPES, PRIORITIES } from './lib/issues/model.js';

// Tools that change data (their calls are flagged in the audit log; what they write is stamped source 'mcp').
export const WRITE_TOOLS = new Set(['create_issue', 'update_issue', 'add_comment', 'log_work', 'add_link']);
// Long free text is recorded only as its length; other values are cut short.
const TEXT_ONLY_LENGTH = new Set(['description', 'body', 'note', 'comment', 'prompt']);
const KEY_RE = /^[A-Za-z][A-Za-z0-9]{1,9}-\d+$/;

/** A safe, short summary of tool arguments for the audit log (no long text, no secrets). */
export function auditArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {}).slice(0, 25)) {
    if (TEXT_ONLY_LENGTH.has(k)) out[k] = typeof v === 'string' ? `[${v.length} characters]` : '[text]';
    else if (k === 'fields' && v && typeof v === 'object') out[k] = Object.keys(v).slice(0, 20);
    else if (Array.isArray(v)) out[k] = v.slice(0, 10).map((x) => String(x).slice(0, 60));
    else if (v && typeof v === 'object') out[k] = '[object]';
    else out[k] = typeof v === 'string' ? v.slice(0, 120) : v;
  }
  return out;
}

/** Issue keys and the project a call touched, from its arguments and its result. */
export function auditTargets(args, result) {
  const keys = new Set();
  const add = (v) => {
    if (typeof v === 'string' && KEY_RE.test(v)) keys.add(v.toUpperCase());
  };
  for (const k of ['key', 'target', 'parent']) add(args?.[k]);
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    add(result.created);
    add(result.key);
    for (const s of result.subtasks || []) add(typeof s === 'string' ? s : s?.key);
  }
  const first = [...keys][0];
  const project =
    (typeof args?.project === 'string' && /^[A-Za-z][A-Za-z0-9]{1,9}$/.test(args.project) ? args.project : first?.split('-')[0]) || null;
  return { keys: [...keys].slice(0, 20), project: project ? project.toUpperCase() : null };
}

/** Append one row to mcp_calls. Never stores the token, only its prefix. Logging never breaks a call. */
async function logCall(db, row) {
  try {
    await db.run(
      `INSERT INTO mcp_calls (id, user_id, token_id, token_prefix, client_name, tool, ok, error, created_at, args, issue_keys, project_key, is_write, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuid(),
        row.userId || null,
        row.tokenId || null,
        row.tokenPrefix || null,
        row.clientName ? String(row.clientName).slice(0, 100) : null,
        row.tool ? String(row.tool).slice(0, 60) : null,
        row.ok ? 1 : 0,
        row.error ? String(row.error).slice(0, 500) : null,
        now(),
        row.args ? JSON.stringify(row.args).slice(0, 2000) : null,
        row.keys?.length ? row.keys.join(',') : null,
        row.project || null,
        row.write ? 1 : 0,
        Number.isFinite(row.ms) ? Math.round(row.ms) : null,
      ],
    );
    // keep the log bounded: now and then, drop rows older than the admin setting (default 90 days)
    if (Math.random() < 0.05) {
      const days = Number((await getSettings(db)).mcpLogDays) || 90;
      await db.run('DELETE FROM mcp_calls WHERE created_at < ?', [new Date(Date.now() - days * 864e5).toISOString()]);
    }
  } catch (e) {
    console.error('mcp log failed', e);
  }
}

/** Log a request to /mcp that sent a credential we refused (tool is NULL for these rows). */
async function logRejected(c) {
  const auth = c.req.header('authorization');
  if (!auth) return; // no credential at all: a client discovering OAuth, not worth a row
  const db = c.env.db;
  const raw = bearerToken(c);
  let row = null;
  let reason = 'Not a tracker token';
  if (raw) {
    row = await db.get(
      `SELECT t.id, t.user_id, t.prefix, t.revoked_at, t.expires_at, t.name, t.kind, u.status, oc.client_name
         FROM api_tokens t JOIN users u ON u.id = t.user_id LEFT JOIN oauth_clients oc ON oc.client_id = t.client_id WHERE t.token_hash = ?`,
      [await sha256(raw)],
    );
    if (!row) reason = 'Unknown token';
    else if (row.revoked_at) reason = 'Token revoked';
    else if (row.expires_at && row.expires_at <= now()) reason = 'Token expired';
    else if (row.status !== 'active') reason = 'User deactivated';
    else if (!(await getSettings(db)).apiTokens) reason = 'API tokens turned off';
  }
  await logCall(db, {
    userId: row?.user_id,
    tokenId: row?.id,
    tokenPrefix: row?.prefix || (raw ? raw.slice(0, 8) : null),
    clientName: row ? (row.kind === 'oauth' ? row.client_name : row.name) : null,
    tool: null,
    ok: false,
    error: reason,
  });
}

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER = { name: 'opentrack', version: '0.1.0' };

const s = (description, extra = {}) => ({ type: 'string', description, ...extra });

export const TOOLS = [
  {
    name: 'list_projects',
    description:
      'List the projects you can see, with their keys, workflow statuses, open sprints, custom fields, components and unreleased versions.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'my_work',
    description: 'Your open issues (assigned to you), issues due soon, and counts by status.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'search_issues',
    description: 'Search issues. All filters are optional and combine with AND.',
    inputSchema: {
      type: 'object',
      properties: {
        text: s('Words in the title, description or key, or an exact key like WEB-12'),
        project: s('Project key, e.g. WEB (comma separated for several)'),
        status: s('Status name, e.g. "In Progress" (comma separated for several)'),
        status_category: s('todo, in_progress, done, or open (= todo and in_progress)'),
        assignee: s('"me", "unassigned", or an email address'),
        reporter: s('"me" or an email address'),
        type: s('epic, story, task, bug or subtask'),
        priority: s('highest, high, medium, low or lowest'),
        label: s('Label'),
        sprint: s('"active", "backlog", or a sprint name'),
        component: s('Component name, or "none" (comma separated for several)'),
        fix_version: s('Fix version (release) name, or "none" (comma separated for several)'),
        sort: s('updated (default), created, priority, rank, key, due'),
        limit: { type: 'number', description: 'Max results, default 25, at most 100' },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_issue',
    description: 'Full details of one issue: description, status, people, sub-tasks, links, comments, history and work log.',
    inputSchema: { type: 'object', properties: { key: s('Issue key, e.g. WEB-12') }, required: ['key'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'create_issue',
    description: 'Create an issue. Returns its key.',
    inputSchema: {
      type: 'object',
      properties: {
        project: s('Project key, e.g. WEB'),
        title: s('Summary'),
        type: s('story, task (default), bug, epic, or subtask (needs parent)', { enum: TYPES }),
        description: s('Markdown'),
        priority: s('Default medium', { enum: PRIORITIES }),
        assignee: s('"me" or an email address'),
        labels: { type: 'array', items: { type: 'string' } },
        parent: s('Epic key for a story/task/bug, or the parent key for a sub-task'),
        status: s('Status name; default is the first column'),
        sprint: s('"active" or a sprint name; default backlog'),
        due_date: s('YYYY-MM-DD'),
        start_date: s('YYYY-MM-DD, the Roadmap start (on or before due_date)'),
        story_points: { type: 'number' },
        template: s(
          "Name of one of the project's issue templates; fills type, title prefix, description, priority, labels and field defaults, and adds its sub-tasks",
        ),
        fields: {
          type: 'object',
          description:
            'Custom fields by name, e.g. {"Customer": "Acme", "Severity": "High"}. Select: the option name; multi-select: a list of option names; user: "me" or an email; checkbox: true or false; date: YYYY-MM-DD; null clears. list_projects shows each project\'s fields.',
        },
        components: {
          type: 'array',
          items: { type: 'string' },
          description: "Component names (list_projects shows them). A component's default assignee takes an unassigned issue.",
        },
        fix_versions: { type: 'array', items: { type: 'string' }, description: 'Fix version (release) names; list_releases shows them' },
      },
      required: ['project', 'title'],
    },
  },
  {
    name: 'update_issue',
    description: 'Change fields of an issue. Only the fields you pass change. Use status to move it on the board.',
    inputSchema: {
      type: 'object',
      properties: {
        key: s('Issue key'),
        title: s('New summary'),
        description: s('New description (Markdown, replaces the old one)'),
        status: s('Status name, e.g. "Done"'),
        priority: s('Priority', { enum: PRIORITIES }),
        assignee: s('"me", "unassigned", or an email address'),
        labels: { type: 'array', items: { type: 'string' }, description: 'Replaces all labels' },
        sprint: s('"active", "backlog", or a sprint name'),
        due_date: s('YYYY-MM-DD, or "" to clear'),
        start_date: s('YYYY-MM-DD, or "" to clear (the Roadmap start; on or before the due date)'),
        story_points: { type: ['number', 'null'] },
        fields: {
          type: 'object',
          description:
            'Custom fields by name, e.g. {"Customer": "Acme", "Severity": "High"}. Select: the option name; multi-select: a list of option names; user: "me" or an email; checkbox: true or false; date: YYYY-MM-DD; null clears. list_projects shows each project\'s fields.',
        },
        components: { type: 'array', items: { type: 'string' }, description: 'Component names; replaces all components ([] clears)' },
        fix_versions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Fix version (release) names; replaces all fix versions ([] clears)',
        },
        comment: s('Resolution comment sent with a status change (some projects require one when moving to a status)'),
      },
      required: ['key'],
    },
  },
  {
    name: 'add_comment',
    description: 'Add a comment (Markdown) to an issue, e.g. a status update. Watchers are notified.',
    inputSchema: { type: 'object', properties: { key: s('Issue key'), body: s('Comment text (Markdown)') }, required: ['key', 'body'] },
  },
  {
    name: 'log_work',
    description: 'Log hours worked on an issue.',
    inputSchema: {
      type: 'object',
      properties: {
        key: s('Issue key'),
        hours: { type: 'number', description: 'Hours, up to 24' },
        note: s('What was done'),
        date: s('YYYY-MM-DD, default today'),
      },
      required: ['key', 'hours'],
    },
  },
  {
    name: 'list_sprints',
    description: 'Sprints of a project (newest first), with state (future, active, closed), dates and goal.',
    inputSchema: {
      type: 'object',
      properties: {
        project: s('Project key, e.g. WEB'),
        include_closed: { type: 'boolean', description: 'Also list closed sprints (default false)' },
      },
      required: ['project'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_releases',
    description:
      'Releases (fix versions) of a project: status (unreleased, released, archived), start and release dates, overdue, and progress (issues and story points done of the total). With release, also its release notes (Markdown).',
    inputSchema: {
      type: 'object',
      properties: {
        project: s('Project key, e.g. WEB'),
        include_archived: { type: 'boolean', description: 'Also list archived releases (default false)' },
        release: s('Name of one release: adds its release notes'),
      },
      required: ['project'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'add_link',
    description: 'Link two issues, e.g. WEB-12 blocks WEB-15.',
    inputSchema: {
      type: 'object',
      properties: {
        key: s('Issue key the link starts from'),
        target: s('Issue key it points to'),
        type: s('blocks, relates (default), duplicates or clones', { enum: ['blocks', 'relates', 'duplicates', 'clones'] }),
      },
      required: ['key', 'target'],
    },
  },
  {
    name: 'project_report',
    description:
      'Project reports, as on the Reports tab: burndown (a sprint, default the active one, else the last closed), velocity (last 6 closed sprints, committed vs completed points), flow (created vs resolved per week), cycle_time (median and 85th percentile days from start of work to resolved), breakdown (open issues by status, assignee, type, priority).',
    inputSchema: {
      type: 'object',
      properties: {
        project: s('Project key, e.g. WEB'),
        kind: s('Which report', { enum: ['burndown', 'velocity', 'flow', 'cycle_time', 'breakdown'] }),
        sprint: s('For burndown: "active" (default) or a sprint name'),
        weeks: { type: 'number', description: 'For flow and cycle_time: weeks to look back, default 12, at most 52' },
      },
      required: ['project', 'kind'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'run_report',
    description:
      'Run a custom report over issues, as on the Reports page. kind: breakdown (count or sum grouped by one field), twoD (rows field x columns field), createdVsResolved (per day, week or month), averageAge (average age of unresolved issues per period), workload (open issues, points and hours per assignee), list (top issues). Pick the issues with query (issue search fields), a saved filter name, or run a saved report by name.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: s('Report kind (not needed with report)', {
          enum: ['breakdown', 'twoD', 'createdVsResolved', 'averageAge', 'workload', 'list'],
        }),
        query: {
          type: 'object',
          description:
            'Issue search fields: project (keys, comma separated), statusName, category (todo, in_progress, done), type, priority, assignee and reporter (me, unassigned or user ids), label, sprint (active, backlog, open or an id), parent (epic key), component and fixVersion (names, ids or none), q (text), dueWithinDays, updatedWithinDays',
        },
        filter: s('Name of a saved filter (yours or shared) instead of query'),
        report: s('Name of a saved report (yours or shared) to run as it is'),
        options: {
          type: 'object',
          description:
            'breakdown: groupBy (status, statusCategory, assignee, reporter, type, priority, label, epic, sprint, project, dueBucket, component, fixVersion), metric (count, storyPoints, estimateHours, loggedHours). twoD: rows, columns, metric. createdVsResolved: period (day, week, month), days (at most 730), cumulative. averageAge: period, days. workload: includeDone. list: sort (created, updated, due, priority), dir, limit (at most 100), columns.',
        },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_users',
    description: 'Find people (name, email) to assign issues to.',
    inputSchema: { type: 'object', properties: { query: s('Part of a name or email') } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_raid',
    description:
      'The project RAID log: risks (probability and impact 1 to 5, score = probability x impact, mitigation, contingency), assumptions, issues and decisions (decided by, decided on, rationale), with owner, status, review date and linked issues. Highest risk score first.',
    inputSchema: {
      type: 'object',
      properties: {
        project: s('Project key, e.g. WEB'),
        type: s('Only this type', { enum: ['risk', 'assumption', 'issue', 'decision'] }),
        status: s(
          'A status (open, monitoring, closed, proposed, agreed, superseded), a comma list, or active (everything not closed or superseded)',
        ),
        overdue: { type: 'boolean', description: 'Only active entries past their review date' },
      },
      required: ['project'],
    },
    annotations: { readOnlyHint: true },
  },
];

class ToolError extends Error {}

const fieldBrief = (f) =>
  `${f.name} (${f.type}${
    f.options?.length
      ? `: ${f.options
          .filter((o) => !o.archived)
          .map((o) => o.name)
          .join(', ')}`
      : ''
  }${f.required ? ', required' : ''})`;

function apiClient(app, env, auth, origin) {
  return async function call(method, path, data) {
    const headers = { authorization: auth };
    if (data !== undefined) headers['content-type'] = 'application/json';
    const res = await app.request(
      new URL(path, origin).toString(),
      { method, headers, body: data === undefined ? undefined : JSON.stringify(data) },
      env,
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new ToolError(json.error || `Request failed (${res.status})`);
    return json;
  };
}

const brief = (i) => ({
  key: i.key,
  title: i.title,
  type: i.type,
  status: i.status.name,
  priority: i.priority,
  assignee: i.assignee?.name || null,
  ...(i.parent ? { parent: i.parent.key } : {}),
  ...(i.sprint ? { sprint: i.sprint.name } : {}),
  ...(i.labels?.length ? { labels: i.labels } : {}),
  ...(i.components?.length ? { components: i.components.map((x) => x.name) } : {}),
  ...(i.fixVersions?.length ? { fix_versions: i.fixVersions.map((x) => x.name) } : {}),
  ...(i.dueDate ? { due: i.dueDate } : {}),
  ...(i.startDate ? { start: i.startDate } : {}),
  ...(i.storyPoints !== null && i.storyPoints !== undefined ? { points: i.storyPoints } : {}),
  updated: i.updatedAt,
});

export function makeTools(call) {
  const people = async (q) => (await call('GET', `/api/users?q=${encodeURIComponent(q || '')}`)).users;
  async function personId(value, field) {
    if (value === undefined) return undefined;
    if (value === null || value === '' || value === 'unassigned') return null;
    if (value === 'me') return (await call('GET', '/api/me')).user.id;
    const v = String(value).toLowerCase();
    const list = await people(v);
    const hit = list.find((u) => u.email.toLowerCase() === v) || (list.length === 1 ? list[0] : null);
    if (!hit) throw new ToolError(`${field}: no single person matches "${value}". Use list_users to find their email.`);
    return hit.id;
  }
  const project = async (key) => (await call('GET', `/api/projects/${encodeURIComponent(key)}`)).project;
  function statusId(p, name) {
    const st = p.statuses.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
    if (!st) throw new ToolError(`No status "${name}" in ${p.key}. Statuses: ${p.statuses.map((x) => x.name).join(', ')}`);
    return st.id;
  }
  function sprintId(p, name) {
    if (name === undefined) return undefined;
    if (!name || name === 'backlog') return null;
    const sp =
      name === 'active'
        ? p.sprints.find((x) => x.state === 'active')
        : p.sprints.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
    if (!sp)
      throw new ToolError(
        `No ${name === 'active' ? 'active sprint' : `open sprint "${name}"`} in ${p.key}. Open sprints: ${p.sprints.map((x) => x.name).join(', ') || 'none'}`,
      );
    return sp.id;
  }

  // Custom fields by name: { "Customer": "Acme" } -> { <fieldId>: value }; user fields take "me" or an email.
  async function fieldsByName(projectKey, input, extra = {}) {
    if (input === undefined || input === null) return Object.keys(extra).length ? extra : undefined;
    if (typeof input !== 'object' || Array.isArray(input)) throw new ToolError('fields must be an object of field name: value');
    const { fields } = await call('GET', `/api/projects/${encodeURIComponent(projectKey)}/fields`);
    const out = { ...extra };
    for (const [name, value] of Object.entries(input)) {
      const f = fields.find((x) => !x.archived && (x.name.toLowerCase() === String(name).toLowerCase() || x.id === name));
      if (!f)
        throw new ToolError(
          `No field "${name}" in ${projectKey}. Fields: ${
            fields
              .filter((x) => !x.archived)
              .map((x) => x.name)
              .join(', ') || 'none'
          }`,
        );
      out[f.id] = f.type === 'user' && value ? await personId(value, f.name) : value;
    }
    return out;
  }
  // get_issue: field values by name, as plain values
  async function namedFields(projectKey, values) {
    if (!values || !Object.keys(values).length) return undefined;
    const { fields } = await call('GET', `/api/projects/${encodeURIComponent(projectKey)}/fields`);
    const out = {};
    for (const f of fields) {
      const v = values[f.id];
      if (v === undefined || v === null) continue;
      out[f.name] = Array.isArray(v) ? v.map((x) => x.name) : v && typeof v === 'object' ? v.name : v;
    }
    return out;
  }

  // get_issue: linked Slack channels (no message contents) and how many AI suggestions wait
  async function channelLinks(key) {
    try {
      const r = await call('GET', `/api/issues/${encodeURIComponent(key)}/channels`);
      if (!r.links.length && !r.suggestions.length) return {};
      return {
        channelLinks: r.links.map((l) => ({
          channel: `#${l.channel.name || l.channel.id}`,
          kind: l.channel.kind,
          thread: Boolean(l.threadTs),
          aiSession: l.sessionOn ? 'on' : 'off',
          lastRun: l.lastRunAt,
        })),
        pendingAiSuggestions: r.suggestions.length,
      };
    } catch {
      return {};
    }
  }

  return {
    async list_projects() {
      const { projects } = await call('GET', '/api/projects');
      const full = await Promise.all(projects.map((p) => project(p.key)));
      return full.map((p) => ({
        key: p.key,
        name: p.name,
        lead: p.leadName,
        visibility: p.visibility,
        canEdit: p.canEdit,
        statuses: p.statuses.map((x) => `${x.name} (${x.category})`),
        openSprints: p.sprints.map((x) => `${x.name} (${x.state})`),
        ...((p.fields || []).some((f) => !f.archived) ? { fields: p.fields.filter((f) => !f.archived).map(fieldBrief) } : {}),
        ...(p.components?.length ? { components: p.components.map((x) => x.name) } : {}),
        ...(p.releases?.some((x) => x.status === 'unreleased')
          ? { unreleasedVersions: p.releases.filter((x) => x.status === 'unreleased').map((x) => x.name) }
          : {}),
      }));
    },
    async my_work() {
      const d = await call('GET', '/api/dashboard');
      return {
        counts: d.counts,
        assignedToMe: d.assigned.map(brief),
        dueSoonOrOverdue: d.dueSoon.map((i) => ({ ...brief(i), overdue: i.overdue })),
      };
    },
    async search_issues(a) {
      const q = new URLSearchParams();
      if (a.text) q.set('q', a.text);
      if (a.project) q.set('project', a.project);
      if (a.status) q.set('statusName', a.status);
      if (a.status_category) q.set('category', a.status_category === 'open' ? 'todo,in_progress' : a.status_category);
      for (const f of ['assignee', 'reporter']) {
        if (!a[f]) continue;
        q.set(f, a[f] === 'me' || a[f] === 'unassigned' ? a[f] : await personId(a[f], f));
      }
      if (a.type) q.set('type', a.type);
      if (a.priority) q.set('priority', a.priority);
      if (a.component) q.set('component', a.component);
      if (a.fix_version) q.set('fixVersion', a.fix_version);
      if (a.component || a.fix_version) q.set('withReleases', '1');
      if (a.label) q.set('label', a.label);
      if (a.sprint) {
        if (a.sprint === 'active' || a.sprint === 'backlog') q.set('sprint', a.sprint);
        else if (a.project) q.set('sprint', sprintId(await project(a.project.split(',')[0]), a.sprint));
        else throw new ToolError('Pass project together with a sprint name');
      }
      q.set('sort', a.sort || 'updated');
      q.set('limit', String(Math.min(Number(a.limit) || 25, 100)));
      const r = await call('GET', `/api/issues?${q}`);
      return { total: r.total, shown: r.issues.length, issues: r.issues.map(brief) };
    },
    async get_issue({ key }) {
      const { issue: i } = await call('GET', `/api/issues/${encodeURIComponent(key)}`);
      return {
        ...brief(i),
        project: i.projectKey,
        reporter: i.reporter?.name || null,
        description: i.description || '',
        created: i.createdAt,
        resolved: i.resolvedAt,
        estimateHours: i.estimateHours,
        loggedHours: i.loggedHours,
        children: i.children.map(brief),
        links: i.links.map((l) => ({
          type: l.type,
          direction: l.direction,
          key: l.issue.key,
          title: l.issue.title,
          status: l.issue.status.name,
        })),
        watchers: i.watchers.map((w) => w.name),
        comments: i.comments
          .filter((c) => !c.deleted)
          .map((c) => ({
            id: c.id,
            ...(c.parentId ? { replyTo: c.parentId } : {}),
            author: c.author?.name || null,
            at: c.createdAt,
            body: c.body,
          })),
        history: i.history.slice(-30).map((h) => ({ who: h.actor?.name || null, field: h.field, from: h.from, to: h.to, at: h.createdAt })),
        worklog: i.worklogs.map((w) => ({ who: w.user.name, hours: w.hours, date: w.workDate, note: w.note })),
        ...(await namedFields(i.projectKey, i.fields).then((f) => (f ? { fields: f } : {}))),
        ...(await channelLinks(key)),
      };
    },
    async create_issue(a) {
      const p = await project(a.project);
      let tpl = null;
      if (a.template) {
        const { templates } = await call('GET', `/api/projects/${encodeURIComponent(p.key)}/templates`);
        tpl = templates.find((t) => t.name.toLowerCase() === String(a.template).toLowerCase());
        if (!tpl)
          throw new ToolError(`No template "${a.template}" in ${p.key}. Templates: ${templates.map((t) => t.name).join(', ') || 'none'}`);
      }
      const { issue } = await call('POST', '/api/issues', {
        projectKey: p.key,
        title: tpl ? applyTitlePrefix(tpl.titlePrefix, a.title) : a.title,
        type: a.type || tpl?.type || 'task',
        description: a.description ?? (tpl?.description || undefined),
        priority: a.priority || tpl?.priority || undefined,
        assigneeId: await personId(a.assignee, 'assignee'),
        labels: tpl ? [...new Set([...tpl.labels, ...(a.labels || [])])] : a.labels,
        parentKey: a.parent,
        statusId: a.status ? statusId(p, a.status) : undefined,
        sprintId: sprintId(p, a.sprint) ?? undefined,
        dueDate: a.due_date,
        startDate: a.start_date,
        storyPoints: a.story_points,
        fields: await fieldsByName(p.key, a.fields, tpl?.fields || {}),
        components:
          tpl?.components?.length || a.components ? [...new Set([...(tpl?.components || []), ...(a.components || [])])] : undefined,
        fixVersions: a.fix_versions,
      });
      const subtasks = [];
      if (tpl && SUBTASK_PARENTS.includes(issue.type)) {
        for (const title of tpl.subtasks)
          subtasks.push((await call('POST', '/api/issues', { projectKey: p.key, type: 'subtask', parentKey: issue.key, title })).issue.key);
      }
      return { created: issue.key, ...brief(issue), ...(subtasks.length ? { subtasks } : {}) };
    },
    async update_issue(a) {
      const { issue: cur } = await call('GET', `/api/issues/${encodeURIComponent(a.key)}`);
      const needsProject = a.status !== undefined || a.sprint !== undefined;
      const p = needsProject ? await project(cur.projectKey) : null;
      const patch = {
        title: a.title,
        description: a.description,
        priority: a.priority,
        labels: a.labels,
        assigneeId: await personId(a.assignee, 'assignee'),
        statusId: a.status !== undefined ? statusId(p, a.status) : undefined,
        sprintId: sprintId(p || {}, a.sprint),
        dueDate: a.due_date === undefined ? undefined : a.due_date || null,
        startDate: a.start_date === undefined ? undefined : a.start_date || null,
        storyPoints: a.story_points,
        fields: await fieldsByName(cur.projectKey, a.fields),
        components: a.components,
        fixVersions: a.fix_versions,
        comment: a.comment, // workflow rules may ask for one with a status change
      };
      const r = await call('PATCH', `/api/issues/${encodeURIComponent(cur.key)}`, patch);
      return { key: cur.key, changed: r.changed, now: brief(r.issue) };
    },
    async add_comment({ key, body }) {
      await call('POST', `/api/issues/${encodeURIComponent(key)}/comments`, { body });
      return { ok: true, key };
    },
    async log_work({ key, hours, note, date }) {
      await call('POST', `/api/issues/${encodeURIComponent(key)}/worklogs`, { hours, note, workDate: date });
      return { ok: true, key, hours };
    },
    async list_sprints({ project: key, include_closed }) {
      const { sprints } = await call('GET', `/api/projects/${encodeURIComponent(key)}/sprints`);
      return sprints
        .filter((x) => include_closed || x.state !== 'closed')
        .map((x) => ({
          name: x.name,
          state: x.state,
          goal: x.goal || undefined,
          start: x.startDate || undefined,
          end: x.endDate || undefined,
          completed: x.completedAt || undefined,
        }));
    },
    async list_releases({ project: key, include_archived, release } = {}) {
      const { releases } = await call('GET', `/api/projects/${encodeURIComponent(key)}/releases`);
      const out = {
        project: String(key).toUpperCase(),
        releases: releases
          .filter((r) => include_archived || r.status !== 'archived')
          .map((r) => ({
            name: r.name,
            status: r.status,
            ...(r.description ? { description: r.description } : {}),
            start: r.startDate || undefined,
            releaseDate: r.releaseDate || undefined,
            releasedAt: r.releasedAt || undefined,
            ...(r.overdue ? { overdue: true } : {}),
            issues: { done: r.progress.done, total: r.progress.total },
            points: { done: r.progress.pointsDone, total: r.progress.points },
          })),
      };
      if (release) {
        const hit = releases.find((r) => r.name.toLowerCase() === String(release).toLowerCase());
        if (!hit)
          throw new ToolError(`No release "${release}" in ${out.project}. Releases: ${releases.map((r) => r.name).join(', ') || 'none'}`);
        out.notes = (await call('GET', `/api/projects/${encodeURIComponent(key)}/releases/${hit.id}/notes`)).markdown;
      }
      return out;
    },
    async add_link({ key, target, type }) {
      await call('POST', `/api/issues/${encodeURIComponent(key)}/links`, { targetKey: target, type: type || 'relates' });
      return { ok: true, from: String(key).toUpperCase(), type: type || 'relates', to: String(target).toUpperCase() };
    },
    async project_report({ project: key, kind, sprint, weeks }) {
      const field = { burndown: 'burndown', velocity: 'velocity', flow: 'flow', cycle_time: 'cycleTime', breakdown: 'breakdown' }[kind];
      if (!field) throw new ToolError('kind must be burndown, velocity, flow, cycle_time or breakdown');
      const base = `/api/projects/${encodeURIComponent(key)}/reports?weeks=${Number(weeks) || 12}`;
      let r = await call('GET', base);
      if (kind === 'burndown' && sprint && sprint !== 'active') {
        const sp = r.sprints.find((x) => x.name.toLowerCase() === String(sprint).toLowerCase());
        if (!sp)
          throw new ToolError(
            `No started sprint "${sprint}" in ${r.project.key}. Sprints: ${r.sprints.map((x) => x.name).join(', ') || 'none'}`,
          );
        r = await call('GET', `${base}&sprint=${encodeURIComponent(sp.id)}`);
      }
      return {
        project: r.project.key,
        kind,
        generatedAt: r.generatedAt,
        ...(kind === 'burndown' ? { sprints: r.sprints.map((x) => x.name) } : {}),
        report: r[field],
      };
    },
    async run_report({ kind, query, filter, report, options } = {}) {
      const byName = (list, name, what) => {
        const hit = list.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
        if (!hit) throw new ToolError(`No ${what} named "${name}". Yours and shared ones: ${list.map((x) => x.name).join(', ') || 'none'}`);
        return hit;
      };
      let r;
      if (report) {
        const saved = byName((await call('GET', '/api/saved-reports')).reports, report, 'saved report');
        r = await call('POST', '/api/report-data', { reportId: saved.id });
      } else {
        let source = { query: query || {} };
        if (filter) source = { filterId: byName((await call('GET', '/api/filters')).filters, filter, 'saved filter').id };
        r = await call('POST', '/api/report-data', { source, kind, options: options || {} });
      }
      return r;
    },
    async list_users({ query } = {}) {
      return (await people(query)).slice(0, 50).map((u) => ({ name: u.name, email: u.email, title: u.title || undefined }));
    },
    async list_raid({ project: key, type, status, overdue } = {}) {
      const q = new URLSearchParams();
      if (type) q.set('type', type);
      if (status) q.set('status', status);
      if (overdue) q.set('overdue', '1');
      const r = await call('GET', `/api/projects/${encodeURIComponent(key)}/raid?${q}`);
      const out = (e) => ({
        ref: e.ref,
        type: e.type,
        title: e.title,
        status: e.status,
        owner: e.owner?.name || null,
        ...(e.reviewDate ? { review: e.reviewDate } : {}),
        ...(e.type === 'risk'
          ? {
              probability: e.probability,
              impact: e.impact,
              score: e.score,
              mitigation: e.mitigation || undefined,
              contingency: e.contingency || undefined,
            }
          : {}),
        ...(e.type === 'decision'
          ? { decided_by: e.decidedBy || undefined, decided_on: e.decidedOn || undefined, rationale: e.rationale || undefined }
          : {}),
        ...(e.description ? { description: e.description.slice(0, 2000) } : {}),
        ...(e.links.length ? { issues: e.links.map((l) => l.key) } : {}),
        updated: e.updatedAt,
      });
      return { project: String(key).toUpperCase(), counts: r.counts, overdue: r.overdue, entries: r.entries.slice(0, 200).map(out) };
    },
  };
}

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export async function handleMcp(c, app) {
  const origin = new URL(c.req.url).origin;
  const reqOrigin = c.req.header('origin');
  if (reqOrigin && reqOrigin !== origin) return c.json({ error: 'Origin not allowed' }, 403);
  if (c.req.method !== 'POST') return c.body(null, 405, { allow: 'POST' });

  const user = await tokenUser(c);
  if (!user) {
    await logRejected(c);
    return c.json(
      rpcError(
        null,
        -32001,
        'Unauthorized: sign in with OAuth, or send Authorization: Bearer <API token> (create one in the tracker under AI connectors).',
      ),
      401,
      {
        'www-authenticate': `Bearer resource_metadata="${publicOrigin(c)}/.well-known/oauth-protected-resource"`,
      },
    );
  }
  let payload;
  try {
    payload = await c.req.json();
  } catch {
    return c.json(rpcError(null, -32700, 'Parse error'), 400);
  }
  // changeSource: the routes stamp 'mcp' on the history rows, comments and work logs these calls write (lib/history.js)
  const call = apiClient(app, { ...c.env, changeSource: 'mcp' }, c.req.header('authorization'), origin);
  const tools = makeTools(call);

  async function one(msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id, -32600, 'Invalid request');
    const isNotification = msg.id === undefined || msg.id === null;
    const ok = (result) => (isNotification ? null : { jsonrpc: '2.0', id: msg.id, result });
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion;
        return ok({
          protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER,
          instructions: `Opentrack (issue tracker). You act as ${user.name} <${user.email}>. Issue keys look like PROJ-123. Use list_projects to see project keys and status names.`,
        });
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: TOOLS });
      case 'tools/call': {
        const name = msg.params?.name;
        const fn = tools[name];
        const args = msg.params?.arguments || {};
        const started = Date.now();
        const write = WRITE_TOOLS.has(name);
        const log = (okay, error, result) => {
          const t = auditTargets(args, result);
          return logCall(c.env.db, {
            userId: user.id,
            tokenId: user.token_id,
            tokenPrefix: user.token_prefix,
            clientName: user.token_kind === 'oauth' ? user.client_name || 'OAuth app' : user.token_name,
            tool: name || '(none)',
            ok: okay,
            error,
            args: auditArgs(args),
            keys: t.keys,
            project: t.project,
            write,
            ms: Date.now() - started,
          });
        };
        if (!fn) {
          await log(false, `Unknown tool: ${name}`);
          return rpcError(msg.id, -32602, `Unknown tool: ${name}`);
        }
        try {
          const result = await fn(args);
          await log(true, null, result);
          return ok({
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            structuredContent: Array.isArray(result) ? { items: result } : result,
          });
        } catch (e) {
          if (!(e instanceof ToolError)) console.error('mcp tool failed', name, e);
          await log(false, e instanceof ToolError ? e.message : 'The tool failed on the server');
          return ok({
            content: [{ type: 'text', text: e instanceof ToolError ? e.message : 'The tool failed on the server' }],
            isError: true,
          });
        }
      }
      default:
        return isNotification ? null : rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  }

  if (Array.isArray(payload)) {
    const results = (await Promise.all(payload.map(one))).filter(Boolean);
    return results.length ? c.json(results) : c.body(null, 202);
  }
  const result = await one(payload);
  return result ? c.json(result) : c.body(null, 202);
}
