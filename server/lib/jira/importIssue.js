// Jira import: writing one Jira issue (with its comments, work logs, labels, links and history) as one batch, and the
// lookups on the run's ctx that it shares with the stages (jira/stages.js).
import { uuid, now as nowIso } from '../crypto.js';
import { historyStmt } from '../history.js';
import { ISSUE_INSERT_SQL } from '../issues/create.js';
import { adfToMarkdown } from '../adf.js';
import { parentTypeError, RANK_STEP } from '../issues/model.js';
import { placeholders, chunks } from '../../db/sql.js';
import {
  JIRA_MAX_FILE,
  MAX_PARAMS,
  jiraTime,
  cut,
  mapPriority,
  mapType,
  mapCategory,
  mapLinkType,
  insertRows,
  mapRow,
  MAP_COLS,
  matchPeople,
  notePerson,
} from './map.js';
import { JiraError, qs } from './client.js';

export function addError(ctx, key, message) {
  ctx.errors.push({ stage: ctx.stage, key, message });
}

export function sprintRow(projectId, s, state) {
  const day = (v) => (jiraTime(v) || '').slice(0, 10) || null;
  return {
    jiraId: String(s.id),
    row: [
      uuid(),
      projectId,
      String(s.name || `Sprint ${s.id}`).slice(0, 80),
      s.goal ? String(s.goal).slice(0, 1000) : null,
      state,
      day(s.startDate),
      day(s.endDate),
      state === 'closed' ? jiraTime(s.completeDate) || jiraTime(s.endDate) : null,
      jiraTime(s.createdDate) || jiraTime(s.startDate) || nowIso(),
    ],
  };
}

export async function mappedIds(ctx, kind, ids) {
  const out = new Set();
  const list = [...new Set(ids.map(String))];
  for (const part of chunks(list, MAX_PARAMS - 2)) {
    for (const r of await ctx.db.all(
      `SELECT jira_id FROM jira_import_map WHERE import_id = ? AND kind = ? AND jira_id IN (${placeholders(part.length)})`,
      [ctx.imp.id, kind, ...part],
    ))
      out.add(r.jira_id);
  }
  return out;
}

export async function mappedIssues(ctx, ids) {
  const out = new Map();
  for (const part of chunks(ids, MAX_PARAMS - 1)) {
    const rows = await ctx.db.all(
      `SELECT jira_id, local_id, local_key, data FROM jira_import_map WHERE import_id = ? AND kind = 'issue' AND jira_id IN (${placeholders(part.length)})`,
      [ctx.imp.id, ...part],
    );
    for (const r of rows) out.set(r.jira_id, { id: r.local_id, key: r.local_key, type: r.data });
  }
  return out;
}

/** The user for a Jira person, matching people first seen in comments or work logs on the fly. */
async function personFor(ctx, a) {
  const p = notePerson(ctx.people, a);
  if (!p) return null;
  if (p.userId === undefined || (p.userId === null && !p.checked)) {
    if (!ctx.matchUsers) ctx.matchUsers = await ctx.db.all('SELECT id, email, name, status FROM users');
    matchPeople({ [p.accountId]: p }, ctx.matchUsers);
    p.checked = true;
  }
  return p;
}

async function fetchAll(ctx, path, listKey) {
  const out = [];
  let startAt = 0;
  for (let page = 0; page < 20; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const r = await ctx.jira.get(`${path}${sep}${qs({ startAt, maxResults: 100 })}`);
    const items = r[listKey] || [];
    out.push(...items);
    if (!items.length || startAt + items.length >= (r.total ?? 0)) break;
    startAt += items.length;
  }
  return out;
}

/** Comments or work logs of one issue; problems other than rate limits are noted and skipped. */
async function issueExtras(ctx, is, path, listKey, what) {
  try {
    return await fetchAll(ctx, `/rest/api/3/issue/${encodeURIComponent(is.key)}/${path}`, listKey);
  } catch (e) {
    if (e instanceof JiraError && (e.status === 429 || e.status === 0 || e.status >= 500 || e.status === 401)) throw e;
    addError(ctx, is.key, `${what} not copied: ${e.message}`);
    return [];
  }
}

function pickSprint(value) {
  const list = Array.isArray(value) ? value.filter((s) => s && typeof s === 'object' && s.id !== undefined) : [];
  return (
    list.find((s) => s.state === 'active') ||
    list.find((s) => s.state === 'future') ||
    list
      .filter((s) => s.state === 'closed')
      .sort((a, b) => String(a.completeDate || a.endDate || '').localeCompare(String(b.completeDate || b.endDate || '')))
      .pop() ||
    null
  );
}

export async function importIssue(ctx, p, is) {
  const f = is.fields || {};
  const imp = ctx.imp;
  // Jira calls first: a rate limit here leaves nothing half done
  const comments = ctx.options.comments ? await issueExtras(ctx, is, 'comment', 'comments', 'Comments') : [];
  const logs = ctx.options.worklogs ? await issueExtras(ctx, is, 'worklog', 'worklogs', 'Work logs') : [];
  // errors and counts are kept only once the issue is written
  const errors = [];
  const count = { sprints: 0, comments: 0, worklogs: 0, attachmentsSkipped: 0 };
  const addError = (c, key, message) => errors.push({ stage: c.stage, key, message });
  const project = ctx.project;
  const keep = p.jiraKey === p.targetKey;
  let number;
  const jiraNumber = Number(String(is.key).split('-').pop());
  if (keep && Number.isInteger(jiraNumber) && jiraNumber > 0 && String(is.key).toUpperCase().startsWith(`${p.jiraKey}-`))
    number = jiraNumber;
  else {
    if (keep) addError(ctx, is.key, 'Jira key did not match the project; the issue got the next free number');
    const seq = await ctx.db.get('SELECT issue_seq FROM projects WHERE id = ?', [project.id]);
    number = seq.issue_seq + 1;
  }
  const key = `${project.key}-${number}`;
  const id = uuid();
  const type = mapType(f.issuetype);

  // status: the mapped Jira status, else the first status of the same category
  const st =
    ctx.statuses.find((s) => s.jira_id === `${p.jiraId}:${f.status?.id}`) ||
    ctx.statuses.find((s) => s.category === mapCategory(f.status?.statusCategory?.key)) ||
    ctx.statuses[0];
  const assignee = await personFor(ctx, f.assignee);
  const reporter = await personFor(ctx, f.reporter);
  const created = jiraTime(f.created) || nowIso();
  const updated = jiraTime(f.updated) || created;
  const resolved = st.category === 'done' ? jiraTime(f.resolutiondate) || updated : null;

  const stmts = [];
  const pending = [];

  // parent
  let parentId = null;
  if (f.parent?.id && type !== 'epic') {
    const par = ctx.mapped.get(String(f.parent.id));
    if (par) {
      const err = parentTypeError(type, par.type);
      if (err) addError(ctx, is.key, `Parent ${f.parent.key} left empty: ${err}`);
      else parentId = par.id;
    } else {
      pending.push(mapRow(imp.id, 'parent', is.id, id, String(f.parent.id), key, type));
    }
  }

  // sprint
  let sprintId = null;
  let newSprint = null;
  const sp = ctx.state.fields?.sprint ? pickSprint(f[ctx.state.fields.sprint]) : null;
  if (sp) {
    sprintId = ctx.sprintMap.get(String(sp.id)) || null;
    if (!sprintId && (sp.state !== 'closed' || ctx.options.closedSprints)) {
      const r = sprintRow(project.id, sp, sp.state === 'closed' ? 'closed' : 'future');
      stmts.push(...insertRows('jira_import_map', MAP_COLS, [mapRow(imp.id, 'sprint', r.jiraId, r.row[0])], ' ON CONFLICT DO NOTHING'));
      stmts.push(
        ...insertRows(
          'sprints',
          ['id', 'project_id', 'name', 'goal', 'state', 'start_date', 'end_date', 'completed_at', 'created_at'],
          [r.row],
        ),
      );
      sprintId = r.row[0];
      newSprint = [r.jiraId, sprintId];
      count.sprints += 1;
    }
  }

  const labels = [...new Set((f.labels || []).map((l) => String(l).trim().replace(/\s+/g, '-').slice(0, 40)).filter(Boolean))].slice(0, 20);
  const sp2 = ctx.state.fields?.storyPoints ? Number(f[ctx.state.fields.storyPoints]) : NaN;
  const storyPoints = Number.isFinite(sp2) && sp2 >= 0 ? Math.min(sp2, 1000) : null;
  const est = Number(f.timeoriginalestimate);
  const estimateHours = Number.isFinite(est) && est > 0 ? Math.min(Math.round((est / 3600) * 100) / 100, 10000) : null;
  const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(f.duedate || '') ? f.duedate : null;
  const description = cut(adfToMarkdown(f.description), 50000) || null;
  const title = String(f.summary || is.key).slice(0, 255);

  stmts.unshift(...insertRows('jira_import_map', MAP_COLS, [mapRow(imp.id, 'issue', is.id, id, is.key, key, type)]));
  stmts.push({
    sql: ISSUE_INSERT_SQL, // the same columns as a normal create; numbers, ranks and dates come from Jira. Not announced, as intended for an import.
    params: [
      id,
      project.id,
      number,
      key,
      type,
      title,
      description,
      st.id,
      mapPriority(f.priority?.name),
      assignee?.userId || null,
      reporter?.userId || null,
      parentId,
      sprintId,
      storyPoints,
      estimateHours,
      dueDate,
      number * RANK_STEP,
      created,
      updated,
      resolved,
      null,
    ],
  });
  stmts.push({ sql: 'UPDATE projects SET issue_seq = ? WHERE id = ? AND issue_seq < ?', params: [number, project.id, number] });
  stmts.push(historyStmt(id, reporter?.userId || null, 'created', null, `Imported from Jira ${is.key}`, created));
  stmts.push(
    ...insertRows(
      'issue_labels',
      ['issue_id', 'label'],
      labels.map((l) => [id, l]),
    ),
  );
  stmts.push(
    ...insertRows(
      'watchers',
      ['issue_id', 'user_id'],
      [...new Set([reporter?.userId, assignee?.userId].filter(Boolean))].map((u) => [id, u]),
    ),
  );

  // comments
  if (ctx.options.comments) {
    const rows = [];
    for (const cm of comments) {
      const who = await personFor(ctx, cm.author);
      let text = adfToMarkdown(cm.body);
      if (!who?.userId) text = `Originally by ${who?.name || 'an unknown Jira user'}:\n\n${text}`;
      const t = jiraTime(cm.created) || created;
      rows.push([uuid(), id, who?.userId || null, cut(text, 20000) || '(empty)', t, jiraTime(cm.updated) || t]);
    }
    stmts.push(...insertRows('comments', ['id', 'issue_id', 'author_id', 'body', 'created_at', 'updated_at'], rows));
    count.comments += rows.length;
  }

  // work logs
  if (ctx.options.worklogs) {
    const rows = [];
    for (const w of logs) {
      const hours = Math.round((Number(w.timeSpentSeconds) / 3600) * 100) / 100;
      if (!(hours > 0)) continue;
      const who = await personFor(ctx, w.author);
      let note = adfToMarkdown(w.comment);
      if (!who?.userId) note = `Originally by ${who?.name || 'an unknown Jira user'}${note ? `: ${note}` : ''}`;
      const started = jiraTime(w.started) || created;
      rows.push([
        uuid(),
        id,
        who?.userId || null,
        hours,
        cut(note, 2000, ' (cut)') || null,
        started.slice(0, 10),
        jiraTime(w.created) || started,
      ]);
    }
    stmts.push(...insertRows('worklogs', ['id', 'issue_id', 'user_id', 'hours', 'note', 'work_date', 'created_at'], rows));
    count.worklogs += rows.length;
  }

  // links: written when the second of the two issues arrives
  const linkRows = [];
  const linkMaps = [];
  for (const l of f.issuelinks || []) {
    const other = l.outwardIssue || l.inwardIssue;
    const o = other && ctx.mapped.get(String(other.id));
    if (!o || !l.id) continue;
    const [source, target] = l.outwardIssue ? [id, o.id] : [o.id, id];
    linkRows.push([uuid(), source, target, mapLinkType(l.type?.name), ctx.user.id, created]);
    linkMaps.push(mapRow(imp.id, 'link', l.id, linkRows.at(-1)[0]));
  }
  stmts.push(...insertRows('jira_import_map', MAP_COLS, linkMaps, ' ON CONFLICT DO NOTHING'));
  stmts.push(...insertRows('issue_links', ['id', 'source_id', 'target_id', 'type', 'created_by', 'created_at'], linkRows));

  // attachments: listed now, copied in the attachments stage
  if (ctx.options.attachments) {
    for (const a of f.attachment || []) {
      if (a.size > JIRA_MAX_FILE) {
        addError(ctx, is.key, `File ${a.filename} skipped: larger than 10 MB (${Math.round(a.size / 1024 / 1024)} MB)`);
        count.attachmentsSkipped += 1;
        continue;
      }
      const who = await personFor(ctx, a.author);
      pending.push(
        mapRow(
          imp.id,
          'attachment',
          a.id,
          null,
          is.key,
          key,
          JSON.stringify({
            id: uuid(),
            issueId: id,
            issueKey: key,
            filename: a.filename,
            mimeType: a.mimeType,
            size: a.size,
            created: jiraTime(a.created),
            userId: who?.userId || null,
          }),
        ),
      );
    }
  }
  stmts.push(...insertRows('jira_import_map', MAP_COLS, pending));

  try {
    await ctx.db.batch(stmts);
  } catch (e) {
    // another step imported it first (the map row's primary key): nothing was written
    if (/unique|constraint|duplicate/i.test(String(e?.message)) && (await mappedIssues(ctx, [String(is.id)])).size) {
      ctx.mapped.set(String(is.id), { id: null, key: null, type });
      return;
    }
    throw e;
  }
  ctx.mapped.set(String(is.id), { id, key, type });
  if (newSprint) ctx.sprintMap.set(...newSprint);
  ctx.errors.push(...errors);
  for (const [k, v] of Object.entries(count)) ctx.progress[k] += v;
  ctx.progress.issues += 1;
  ctx.progress.links += linkRows.length;
  const pp = (ctx.progress.perProject[p.jiraKey] ||= { issues: 0 });
  pp.issues += 1;
}
