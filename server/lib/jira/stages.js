// Jira import: the stages of a run, in order (see the list in lib/jiraImport.js). Each STAGE_FNS entry does one unit
// of work on the run's ctx and moves on with nextStage when its part is finished.
import { uuid, now as nowIso, avatarColor } from '../crypto.js';
import { audit } from '../audit.js';
import { fileStore } from '../files.js';
import { EMAIL_RE } from '../http.js';
import { parentTypeError } from '../issues/model.js';
import { parseJson as j } from '../json.js';
import { JIRA_MAX_FILE, MAX_LISTED, mapType, mapCategory, insertRows, mapRow, MAP_COLS, matchPeople, notePerson } from './map.js';
import { JiraError, qs } from './client.js';
import { importIssue, addError, sprintRow, mappedIds, mappedIssues } from './importIssue.js';

const STAGES_IMPORT = ['fields', 'scan', 'users', 'project', 'sprints', 'issues', 'parents', 'attachments', 'finish'];

function projectAt(ctx) {
  return ctx.plan.projects[ctx.state.pi || 0];
}

function nextStage(ctx) {
  const order = STAGES_IMPORT;
  const i = order.indexOf(ctx.stage);
  if (ctx.stage === 'issues' && (ctx.state.pi || 0) + 1 < ctx.plan.projects.length) {
    ctx.state.pi = (ctx.state.pi || 0) + 1;
    ctx.stage = 'project';
  } else {
    ctx.stage = order[i + 1];
    if (ctx.stage === 'project') ctx.state.pi = 0;
  }
  ctx.state.token = null;
  ctx.state.offset = 0;
  ctx.page = null;
}

export const STAGE_FNS = {
  async fields(ctx) {
    const fields = await ctx.jira.get('/rest/api/3/field');
    const find = (test) => (fields || []).find(test)?.id || null;
    ctx.state.fields = {
      storyPoints: find((f) => /^story point estimate$/i.test(f.name)) || find((f) => /^story points$/i.test(f.name)),
      sprint: find((f) => f.schema?.custom === 'com.pyxis.greenhopper.jira:gh-sprint') || find((f) => /^sprint$/i.test(f.name)),
    };
    ctx.stage = 'scan';
    ctx.state.pi = 0;
    ctx.state.token = null;
    if (!ctx.dryRun) ctx.dryRun = { projects: [], totals: {}, people: null };
  },

  async scan(ctx) {
    const pi = ctx.state.pi || 0;
    const p = ctx.plan.projects[pi];
    if (!p) {
      // every project scanned
      matchPeople(ctx.people, await ctx.db.all('SELECT id, email, name, status FROM users'));
      ctx.dryRun.totals = totals(ctx.dryRun.projects);
      ctx.dryRun.people = peopleSummary(ctx.people);
      ctx.dryRun.done = true;
      if (ctx.mode === 'dryrun') {
        ctx.status = 'ready';
        ctx.stage = 'scan';
      } else {
        ctx.stage = 'users';
      }
      ctx.state.pi = 0;
      ctx.state.token = null;
      return;
    }
    let d = ctx.dryRun.projects[pi];
    if (!d) {
      const statuses = await jiraStatuses(ctx, p);
      const sprints = await listSprints(ctx, p);
      d = {
        jiraKey: p.jiraKey,
        targetKey: p.targetKey,
        issues: 0,
        epics: 0,
        subtasks: 0,
        statuses: statuses.length,
        sprints: { active: 0, future: 0, closed: 0 },
        attachments: 0,
        attachmentsTooBig: [],
        tooBigCount: 0,
      };
      for (const s of sprints) d.sprints[s.state] = (d.sprints[s.state] || 0) + 1;
      ctx.dryRun.projects[pi] = d;
      return;
    }
    const r = await searchPage(ctx, p, ctx.state.token, ['issuetype', 'assignee', 'reporter', 'attachment']);
    for (const is of r.issues || []) {
      const f = is.fields || {};
      d.issues += 1;
      const type = mapType(f.issuetype);
      if (type === 'epic') d.epics += 1;
      if (type === 'subtask') d.subtasks += 1;
      for (const who of [f.assignee, f.reporter]) {
        const person = notePerson(ctx.people, who);
        if (person) person.issues = (person.issues || 0) + 1;
      }
      for (const a of f.attachment || []) {
        d.attachments += 1;
        if (a.size > JIRA_MAX_FILE) {
          d.tooBigCount += 1;
          if (d.attachmentsTooBig.length < MAX_LISTED) d.attachmentsTooBig.push({ issue: is.key, filename: a.filename, size: a.size });
        }
      }
    }
    if (r.isLast || !r.nextPageToken || !(r.issues || []).length) {
      ctx.state.pi = pi + 1;
      ctx.state.token = null;
    } else {
      ctx.state.token = r.nextPageToken;
    }
  },

  async users(ctx) {
    const users = await ctx.db.all('SELECT id, email, name, status FROM users');
    matchPeople(ctx.people, users);
    const emails = new Set(users.map((u) => u.email.toLowerCase()));
    if (ctx.options.createUsers) {
      const t = nowIso();
      const rows = [];
      for (const p of Object.values(ctx.people)) {
        if (p.userId || !p.email || !EMAIL_RE.test(p.email) || emails.has(p.email.toLowerCase())) continue;
        const id = uuid();
        const email = p.email.toLowerCase();
        emails.add(email);
        rows.push([id, email, String(p.name || email).slice(0, 100), 'member', 'invited', avatarColor(email), t, t]);
        p.userId = id;
        p.how = 'created';
      }
      if (rows.length) {
        await ctx.db.batch([
          ...insertRows('users', ['id', 'email', 'name', 'role', 'status', 'avatar_color', 'created_at', 'updated_at'], rows),
          audit(ctx.user.id, 'jira_import.users_created', 'jira_import', ctx.imp.id, { count: rows.length }),
        ]);
        ctx.progress.usersCreated += rows.length;
      }
    }
    ctx.stage = 'project';
    ctx.state.pi = 0;
  },

  async project(ctx) {
    const p = projectAt(ctx);
    const done = await ctx.db.get(`SELECT local_id FROM jira_import_map WHERE import_id = ? AND kind = 'project' AND jira_id = ?`, [
      ctx.imp.id,
      p.jiraId,
    ]);
    if (done) {
      ctx.stage = 'sprints';
      ctx.state.sp = null;
      return;
    }
    if (await ctx.db.get('SELECT id FROM projects WHERE key = ?', [p.targetKey])) {
      addError(ctx, p.jiraKey, `Project key ${p.targetKey} was taken before the import reached it. ${p.jiraKey} was skipped.`);
      p.skipped = true;
      ctx.stage = 'issues';
      nextStage(ctx);
      return;
    }
    const statuses = await jiraStatuses(ctx, p);
    const order = { todo: 0, in_progress: 1, done: 2 };
    const list = statuses
      .map((s, i) => ({ ...s, category: mapCategory(s.statusCategory?.key), i }))
      .sort((a, b) => order[a.category] - order[b.category] || a.i - b.i);
    if (!list.length) list.push({ id: 'default', name: 'To Do', category: 'todo' }, { id: 'default-done', name: 'Done', category: 'done' });
    const projectId = uuid();
    const t = nowIso();
    const statusRows = list.map((s, i) => [uuid(), projectId, String(s.name).slice(0, 50), s.category, i, s.id]);
    await ctx.db.batch([
      // the map row first: a repeated step fails here and changes nothing
      ...insertRows('jira_import_map', MAP_COLS, [mapRow(ctx.imp.id, 'project', p.jiraId, projectId, p.jiraKey, p.targetKey)]),
      {
        sql: `INSERT INTO projects (id, key, name, description, lead_id, visibility, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
        params: [
          projectId,
          p.targetKey,
          String(p.name || p.jiraKey).slice(0, 100),
          `Imported from Jira (${ctx.imp.site}/browse/${p.jiraKey}).`,
          ctx.user.id,
          ctx.user.id,
          t,
          t,
        ],
      },
      ...insertRows(
        'statuses',
        ['id', 'project_id', 'name', 'category', 'position'],
        statusRows.map((r) => r.slice(0, 5)),
      ),
      ...insertRows(
        'jira_import_map',
        MAP_COLS,
        statusRows.map((r) => mapRow(ctx.imp.id, 'status', `${p.jiraId}:${r[5]}`, r[0])),
      ),
      {
        sql: `INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'admin', ?)`,
        params: [projectId, ctx.user.id, t],
      },
      audit(ctx.user.id, 'project.created', 'project', projectId, { key: p.targetKey, name: p.name, from: 'jira' }),
    ]);
    ctx.progress.projects += 1;
    ctx.progress.statuses += statusRows.length;
    ctx.progress.perProject[p.jiraKey] = { issues: 0 };
    ctx.stage = 'sprints';
    ctx.state.sp = null;
  },

  async sprints(ctx) {
    const p = projectAt(ctx);
    const project = await localProject(ctx, p);
    const sprints = await listSprints(ctx, p);
    const keep = sprints.filter((s) => s.state !== 'closed' || ctx.options.closedSprints);
    const known = await mappedIds(
      ctx,
      'sprint',
      keep.map((s) => s.id),
    );
    const hasActive = await ctx.db.get(`SELECT id FROM sprints WHERE project_id = ? AND state = 'active'`, [project.id]);
    let active = Boolean(hasActive);
    const rows = [];
    for (const s of keep) {
      if (known.has(String(s.id))) continue;
      let state = ['active', 'future', 'closed'].includes(s.state) ? s.state : 'future';
      if (state === 'active' && active) {
        state = 'future';
        addError(ctx, p.jiraKey, `Sprint "${s.name}" is active in Jira next to another active sprint; it was imported as a future sprint.`);
      }
      if (state === 'active') active = true;
      rows.push(sprintRow(project.id, s, state));
    }
    if (rows.length) {
      await ctx.db.batch([
        ...insertRows(
          'jira_import_map',
          MAP_COLS,
          rows.map((r) => mapRow(ctx.imp.id, 'sprint', r.jiraId, r.row[0])),
        ),
        ...insertRows(
          'sprints',
          ['id', 'project_id', 'name', 'goal', 'state', 'start_date', 'end_date', 'completed_at', 'created_at'],
          rows.map((r) => r.row),
        ),
      ]);
      ctx.progress.sprints += rows.length;
    }
    ctx.stage = 'issues';
    ctx.state.token = null;
    ctx.state.offset = 0;
  },

  async issues(ctx) {
    const p = projectAt(ctx);
    if (!ctx.page) {
      const fields = [
        'summary',
        'description',
        'issuetype',
        'status',
        'priority',
        'assignee',
        'reporter',
        'labels',
        'duedate',
        'created',
        'updated',
        'resolutiondate',
        'parent',
        'timeoriginalestimate',
        'issuelinks',
      ];
      if (ctx.options.attachments) fields.push('attachment');
      if (ctx.state.fields?.storyPoints) fields.push(ctx.state.fields.storyPoints);
      if (ctx.state.fields?.sprint) fields.push(ctx.state.fields.sprint);
      const r = await searchPage(ctx, p, ctx.state.token, fields);
      ctx.page = r;
      const refs = new Set();
      for (const is of r.issues || []) {
        refs.add(String(is.id));
        if (is.fields?.parent?.id) refs.add(String(is.fields.parent.id));
        for (const l of is.fields?.issuelinks || []) {
          const o = l.outwardIssue || l.inwardIssue;
          if (o?.id) refs.add(String(o.id));
        }
      }
      ctx.mapped = await mappedIssues(ctx, [...refs]);
      ctx.project = await localProject(ctx, p);
      ctx.statuses = await ctx.db.all(
        `SELECT s.id, s.category, s.position, m.jira_id FROM statuses s LEFT JOIN jira_import_map m ON m.local_id = s.id AND m.kind = 'status' AND m.import_id = ?
          WHERE s.project_id = ? ORDER BY s.position`,
        [ctx.imp.id, ctx.project.id],
      );
      ctx.sprintMap = new Map(
        (await ctx.db.all(`SELECT jira_id, local_id FROM jira_import_map WHERE import_id = ? AND kind = 'sprint'`, [ctx.imp.id])).map(
          (r) => [r.jira_id, r.local_id],
        ),
      );
      ctx.matchUsers = null;
      return;
    }
    const list = ctx.page.issues || [];
    const offset = ctx.state.offset || 0;
    if (offset >= list.length) {
      if (ctx.page.isLast || !ctx.page.nextPageToken || !list.length) {
        nextStage(ctx);
      } else {
        ctx.state.token = ctx.page.nextPageToken;
        ctx.state.offset = 0;
        ctx.page = null;
      }
      return;
    }
    const is = list[offset];
    if (!ctx.mapped.has(String(is.id))) await importIssue(ctx, p, is);
    ctx.state.offset = offset + 1;
  },

  async parents(ctx) {
    const rows = await ctx.db.all(
      `SELECT p.jira_id, p.local_id, p.jira_key AS parent_jira_id, p.data AS type, p.local_key, m.local_id AS parent_local_id, m.data AS parent_type
         FROM jira_import_map p LEFT JOIN jira_import_map m ON m.import_id = p.import_id AND m.kind = 'issue' AND m.jira_id = p.jira_key
        WHERE p.import_id = ? AND p.kind = 'parent' ORDER BY p.jira_id LIMIT 40`,
      [ctx.imp.id],
    );
    if (!rows.length) {
      ctx.stage = 'attachments';
      return;
    }
    const stmts = [];
    for (const r of rows) {
      const err = r.parent_local_id ? parentTypeError(r.type, r.parent_type) : 'its parent was not imported';
      if (err) addError(ctx, r.local_key, `Parent left empty: ${err}`);
      else {
        stmts.push({ sql: 'UPDATE issues SET parent_id = ? WHERE id = ?', params: [r.parent_local_id, r.local_id] });
        ctx.progress.parents += 1;
      }
      stmts.push({
        sql: `DELETE FROM jira_import_map WHERE import_id = ? AND kind = 'parent' AND jira_id = ?`,
        params: [ctx.imp.id, r.jira_id],
      });
    }
    await ctx.db.batch(stmts);
  },

  async attachments(ctx) {
    const r = await ctx.db.get(
      `SELECT jira_id, data FROM jira_import_map WHERE import_id = ? AND kind = 'attachment' AND local_id IS NULL ORDER BY jira_id LIMIT 1`,
      [ctx.imp.id],
    );
    if (!r) {
      ctx.stage = 'finish';
      return;
    }
    const a = j(r.data, {});
    const done = (localId) =>
      ctx.db.run(`UPDATE jira_import_map SET local_id = ? WHERE import_id = ? AND kind = 'attachment' AND jira_id = ?`, [
        localId,
        ctx.imp.id,
        r.jira_id,
      ]);
    let bytes;
    try {
      const res = await ctx.jira.raw(`/rest/api/3/attachment/content/${encodeURIComponent(r.jira_id)}`);
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if (e instanceof JiraError && (e.status === 429 || e.status === 0 || e.status >= 500 || e.status === 401)) throw e;
      addError(ctx, a.issueKey, `File ${a.filename} not copied: ${e.message}`);
      ctx.progress.attachmentsSkipped += 1;
      await done('skipped');
      return;
    }
    if (bytes.length > JIRA_MAX_FILE) {
      addError(ctx, a.issueKey, `File ${a.filename} skipped: larger than 10 MB`);
      ctx.progress.attachmentsSkipped += 1;
      await done('skipped');
      return;
    }
    const store = fileStore({ ...ctx.env, db: ctx.db });
    await ctx.db.batch([
      { sql: 'DELETE FROM attachments WHERE id = ?', params: [a.id] }, // a step that died half-way left this row and its chunks
      {
        sql: `INSERT INTO attachments (id, issue_id, filename, content_type, size, storage, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          a.id,
          a.issueId,
          String(a.filename || 'file').slice(-200),
          a.mimeType || 'application/octet-stream',
          bytes.length,
          store.kind,
          a.userId || null,
          a.created || nowIso(),
        ],
      },
    ]);
    await store.put(a.id, bytes, a.mimeType);
    await done(a.id);
    ctx.progress.attachments += 1;
  },

  async finish(ctx) {
    ctx.status = 'done';
  },
};

function totals(projects) {
  const t = { issues: 0, epics: 0, subtasks: 0, statuses: 0, sprints: 0, attachments: 0, attachmentsTooBig: 0 };
  for (const p of projects) {
    t.issues += p.issues;
    t.epics += p.epics;
    t.subtasks += p.subtasks;
    t.statuses += p.statuses;
    t.sprints += p.sprints.active + p.sprints.future + p.sprints.closed;
    t.attachments += p.attachments;
    t.attachmentsTooBig += p.tooBigCount;
  }
  return t;
}

function peopleSummary(people) {
  const all = Object.values(people);
  const matched = all.filter((p) => p.userId);
  const unmatched = all.filter((p) => !p.userId);
  return {
    matched: matched.length,
    unmatched: unmatched.length,
    list: [...unmatched, ...matched]
      .slice(0, MAX_LISTED)
      .map((p) => ({ name: p.name, email: p.email, matched: Boolean(p.userId), how: p.how || null, issues: p.issues || 0 })),
  };
}

async function jiraStatuses(ctx, p) {
  const types = await ctx.jira.get(`/rest/api/3/project/${encodeURIComponent(p.jiraKey)}/statuses`);
  const seen = new Map();
  for (const t of types || [])
    for (const s of t.statuses || [])
      if (!seen.has(String(s.id))) seen.set(String(s.id), { id: String(s.id), name: s.name, statusCategory: s.statusCategory });
  return [...seen.values()];
}

/** Sprints of the project's scrum boards (kanban boards have none). */
async function listSprints(ctx, p) {
  const boards = [];
  let startAt = 0;
  for (let page = 0; page < 20; page++) {
    const r = await ctx.jira.get(`/rest/agile/1.0/board?${qs({ projectKeyOrId: p.jiraKey, startAt, maxResults: 50 })}`);
    boards.push(...(r.values || []));
    if (r.isLast || !(r.values || []).length) break;
    startAt += r.values.length;
  }
  const out = new Map();
  for (const b of boards) {
    if (b.type && b.type !== 'scrum') continue;
    let at = 0;
    for (let page = 0; page < 20; page++) {
      let r;
      try {
        r = await ctx.jira.get(`/rest/agile/1.0/board/${encodeURIComponent(b.id)}/sprint?${qs({ startAt: at, maxResults: 50 })}`);
      } catch (e) {
        if (e instanceof JiraError && e.status === 400) break; // the board has no sprints
        throw e;
      }
      for (const s of r.values || []) if (!out.has(String(s.id))) out.set(String(s.id), s);
      if (r.isLast || !(r.values || []).length) break;
      at += r.values.length;
    }
  }
  return [...out.values()];
}

function searchPage(ctx, p, token, fields) {
  return ctx.jira.post('/rest/api/3/search/jql', {
    jql: `project = "${p.jiraKey}" ORDER BY key ASC`,
    fields,
    maxResults: ctx.lim.pageSize,
    ...(token ? { nextPageToken: token } : {}),
  });
}

async function localProject(ctx, p) {
  if (ctx.projectCache?.jiraId === p.jiraId) return ctx.projectCache.project;
  const r = await ctx.db.get(
    `SELECT pr.id, pr.key FROM jira_import_map m JOIN projects pr ON pr.id = m.local_id WHERE m.import_id = ? AND m.kind = 'project' AND m.jira_id = ?`,
    [ctx.imp.id, p.jiraId],
  );
  if (!r) throw new Error(`Project ${p.targetKey} is missing`);
  ctx.projectCache = { jiraId: p.jiraId, project: r };
  return r;
}
