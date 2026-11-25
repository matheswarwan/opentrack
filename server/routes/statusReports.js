// Project status reports (server/lib/statusReports.js): draft from tracker data, edit, publish, share with guests.
//   GET    /api/projects/:key/status-reports              list (guests: published and shared only)
//   POST   /api/projects/:key/status-reports              create a draft { periodStart?, periodEnd? } (project admins)
//   GET    /api/projects/:key/status-reports/:id          one report
//   PATCH  /api/projects/:key/status-reports/:id          edit a draft { summary, rag, sections, sharedWithGuests }
//   POST   /api/projects/:key/status-reports/:id/publish  publish a draft (notifies members, and guests when shared)
//   POST   /api/projects/:key/status-reports/:id/unpublish  back to draft (project admins)
//   POST   /api/projects/:key/status-reports/:id/ai-summary  a summary drafted by the AI (not saved)
//   DELETE /api/projects/:key/status-reports/:id          delete a draft
//   GET    /api/status-summary                            latest published RAG per visible project (portfolio)
import { body, fail, str, isoDate } from '../lib/http.js';
import { uuid, now } from '../lib/crypto.js';
import { noticeStmts } from '../lib/notifications.js';
import { projectAccess, visibleProjectsSql, isGuest } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import { getSettings } from '../lib/settings.js';
import { aiConfigured, aiComplete, AiError, logAiError, explainAiError } from '../lib/ai.js';
import { clock } from '../lib/time.js';
import {
  computeDraft,
  defaultPeriod,
  reportOut,
  reportBrief,
  RAG_VALUES,
  SECTION_KEYS,
  aiSummaryPrompt,
  AI_SUMMARY_SYSTEM,
} from '../lib/statusReports.js';

const MAX_PERIOD_DAYS = 92;
const MAX_ITEMS = 200;
const MAX_SECTIONS_BYTES = 200000;
const SELECT = 'SELECT r.*, u.name AS author_name FROM status_reports r LEFT JOIN users u ON u.id = r.author_id';

/** AI drafting is offered when a provider is configured and channel AI is on for the workspace. */
async function aiAvailable(c) {
  if (!aiConfigured(c.env)) return false;
  return Boolean((await getSettings(c.env.db)).channelAi);
}

async function loadReport(c, need = 'view') {
  const a = await projectAccess(c, c.req.param('key'), need);
  const row = await c.env.db.get(`${SELECT} WHERE r.id = ? AND r.project_id = ?`, [c.req.param('id'), a.project.id]);
  // guests: published reports shared with guests only; drafts do not exist for them
  if (!row || (a.guest && (row.status !== 'published' || !Number(row.shared_with_guests)))) fail(404, 'Status report not found');
  return { a, row, db: c.env.db };
}

const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** One list item as edited in the browser: known fields only, short text. */
function cleanItem(x) {
  if (!x || typeof x !== 'object') return null;
  const out = {};
  for (const k of ['key', 'title', 'type', 'priority', 'status', 'assignee', 'dueDate', 'why', 'id', 'name', 'date', 'text']) {
    const v = text(x[k], k === 'text' || k === 'title' ? 1000 : 200);
    if (v !== undefined && v !== null) out[k] = v;
  }
  for (const k of ['done', 'total', 'hours']) if (Number.isFinite(Number(x[k])) && x[k] !== null && x[k] !== '') out[k] = Number(x[k]);
  if (x.overdue !== undefined) out.overdue = Boolean(x.overdue);
  if (x.epic && typeof x.epic === 'object') out.epic = { key: text(x.epic.key, 40) || null, title: text(x.epic.title, 500) || '' };
  if (Array.isArray(x.reasons))
    out.reasons = x.reasons
      .slice(0, 10)
      .map((r) => text(r, 300))
      .filter((r) => typeof r === 'string');
  return Object.keys(out).length ? out : null;
}

/** The sections object from a PATCH, merged over the stored one. */
function readSections(input, current) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'sections must be an object');
  const out = { ...current };
  for (const [k, v] of Object.entries(input)) {
    if (!SECTION_KEYS.includes(k)) fail(400, `Unknown section: ${k}`);
    if (!v || typeof v !== 'object') fail(400, `Section ${k} must be an object`);
    const cur = current[k] || { items: [], text: '', internal: false };
    const items =
      v.items === undefined
        ? cur.items
        : Array.isArray(v.items)
          ? v.items.slice(0, MAX_ITEMS).map(cleanItem).filter(Boolean)
          : fail(400, `Section ${k}: items must be a list`);
    const t = v.text === undefined ? cur.text : str(v.text, { max: 20000, name: `Section ${k} text` }) || '';
    out[k] = { ...cur, items, text: t, internal: v.internal === undefined ? Boolean(cur.internal) : Boolean(v.internal) };
    if (k === 'time' && v.hidden !== undefined) out[k].hidden = Boolean(v.hidden);
  }
  const json = JSON.stringify(out);
  if (json.length > MAX_SECTIONS_BYTES) fail(400, 'The report is too long');
  return json;
}

/** RAG edits { dim: { value, reason } }: an override of the suggestion needs a reason. */
function readRag(input, current) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'rag must be an object');
  const out = { ...current };
  for (const [k, v] of Object.entries(input)) {
    if (!out[k]) fail(400, `Unknown RAG area: ${k}`);
    if (!v || typeof v !== 'object') fail(400, `RAG ${k} must be an object`);
    const value = v.value === undefined ? out[k].value : v.value;
    if (!RAG_VALUES.includes(value)) fail(400, `RAG ${k} must be green, amber or red`);
    const reason = v.reason === undefined ? out[k].reason : str(v.reason, { max: 1000, name: `Reason for ${k}` }) || '';
    if (value !== out[k].suggested && !reason)
      fail(
        400,
        `Give a reason for changing ${k === 'overall' ? 'the overall RAG' : `the ${k} RAG`} from the suggested ${out[k].suggested}`,
      );
    out[k] = { ...out[k], value, reason };
  }
  return out;
}

function readPeriod(b, nowMs) {
  const d = defaultPeriod(nowMs);
  const start = isoDate(b.periodStart, 'Period start') || null;
  const end = isoDate(b.periodEnd, 'Period end') || null;
  const p = {
    start: start || (end ? new Date(Date.parse(`${end}T00:00:00Z`) - 6 * 864e5).toISOString().slice(0, 10) : d.start),
    end: end || (start ? new Date(Date.parse(`${start}T00:00:00Z`) + 6 * 864e5).toISOString().slice(0, 10) : d.end),
  };
  if (p.start > p.end) fail(400, 'Period start must be on or before the period end');
  if ((Date.parse(p.end) - Date.parse(p.start)) / 864e5 + 1 > MAX_PERIOD_DAYS) fail(400, `A period can be at most ${MAX_PERIOD_DAYS} days`);
  return p;
}

const periodLabel = (r) => `${r.period_start} to ${r.period_end}`;
const RAG_WORD = { green: 'Green', amber: 'Amber', red: 'Red' };

export function registerStatusReports(app) {
  app.get('/api/projects/:key/status-reports', async (c) => {
    const a = await projectAccess(c, c.req.param('key'));
    const guest = a.guest;
    const [rows, ai] = await Promise.all([
      c.env.db.all(
        `${SELECT} WHERE r.project_id = ?${guest ? ` AND r.status = 'published' AND r.shared_with_guests = 1` : ''} ORDER BY r.period_end DESC, r.created_at DESC LIMIT 200`,
        [a.project.id],
      ),
      a.canAdmin ? aiAvailable(c) : false,
    ]);
    return c.json({ reports: rows.map(reportBrief), canAdmin: a.canAdmin, aiAvailable: ai });
  });

  app.post('/api/projects/:key/status-reports', async (c) => {
    const a = await projectAccess(c, c.req.param('key'), 'admin');
    const db = c.env.db;
    const nowMs = clock(c.env);
    const period = readPeriod(await body(c), nowMs);
    const draft = await computeDraft(db, a.project, period, nowMs);
    const id = uuid();
    const t = now();
    await db.batch([
      {
        sql: `INSERT INTO status_reports (id, project_id, period_start, period_end, rag, summary, sections, data, status, published_at, author_id, shared_with_guests, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', NULL, ?, 0, ?, ?)`,
        params: [
          id,
          a.project.id,
          period.start,
          period.end,
          JSON.stringify(draft.rag),
          '',
          JSON.stringify(draft.sections),
          JSON.stringify(draft.data),
          c.get('user').id,
          t,
          t,
        ],
      },
      audit(c.get('user').id, 'status_report.created', 'project', a.project.id, { id, period: `${period.start} to ${period.end}` }),
    ]);
    const row = await db.get(`${SELECT} WHERE r.id = ?`, [id]);
    return c.json({ report: reportOut(row) }, 201);
  });

  app.get('/api/projects/:key/status-reports/:id', async (c) => {
    const { a, row } = await loadReport(c);
    return c.json({
      report: reportOut(row, { forGuest: a.guest }),
      project: { key: a.project.key, name: a.project.name },
      canAdmin: a.canAdmin,
    });
  });

  app.patch('/api/projects/:key/status-reports/:id', async (c) => {
    const { row, db } = await loadReport(c, 'admin');
    if (row.status !== 'draft') fail(409, 'A published report is read only. Unpublish it to change it.');
    const b = await body(c);
    const sets = [];
    const params = [];
    if (b.summary !== undefined) {
      sets.push('summary = ?');
      params.push(str(b.summary, { max: 20000, name: 'Summary' }) || '');
    }
    if (b.rag !== undefined) {
      sets.push('rag = ?');
      params.push(JSON.stringify(readRag(b.rag, JSON.parse(row.rag))));
    }
    if (b.sections !== undefined) {
      sets.push('sections = ?');
      params.push(readSections(b.sections, JSON.parse(row.sections)));
    }
    if (b.sharedWithGuests !== undefined) {
      sets.push('shared_with_guests = ?');
      params.push(b.sharedWithGuests ? 1 : 0);
    }
    if (sets.length) await db.run(`UPDATE status_reports SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...params, now(), row.id]);
    return c.json({ report: reportOut(await db.get(`${SELECT} WHERE r.id = ?`, [row.id])) });
  });

  app.post('/api/projects/:key/status-reports/:id/publish', async (c) => {
    const { a, row, db } = await loadReport(c, 'admin');
    if (row.status !== 'draft') fail(409, 'This report is already published');
    const t = now();
    const user = c.get('user');
    const shared = Boolean(Number(row.shared_with_guests));
    // project members (and guest members when shared), never the author
    const members = await db.all(
      `SELECT m.user_id, u.role FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? AND u.status = 'active' AND u.is_system = 0`,
      [a.project.id],
    );
    const rag = JSON.parse(row.rag);
    const message = `Status report for ${a.project.name} (${periodLabel(row)}) published. Overall: ${RAG_WORD[rag.overall?.value] || 'not set'}.`;
    const link = `/projects/${a.project.key}/status/${row.id}`;
    const stmts = [
      {
        sql: `UPDATE status_reports SET status = 'published', published_at = ?, updated_at = ? WHERE id = ? AND status = 'draft'`,
        params: [t, t, row.id],
      },
      audit(user.id, 'status_report.published', 'project', a.project.id, { id: row.id, shared }),
    ];
    const readers = members.filter((m) => m.user_id !== user.id && (m.role !== 'guest' || shared));
    stmts.push(
      ...noticeStmts(
        readers.map((m) => ({ userId: m.user_id, type: 'status_report', actorId: user.id, message, at: t, projectId: a.project.id, link })),
      ),
    );
    await db.batch(stmts);
    return c.json({ report: reportOut(await db.get(`${SELECT} WHERE r.id = ?`, [row.id])), notified: stmts.length - 2 });
  });

  app.post('/api/projects/:key/status-reports/:id/unpublish', async (c) => {
    const { a, row, db } = await loadReport(c, 'admin');
    if (row.status !== 'published') fail(409, 'This report is not published');
    const t = now();
    await db.batch([
      { sql: `UPDATE status_reports SET status = 'draft', published_at = NULL, updated_at = ? WHERE id = ?`, params: [t, row.id] },
      audit(c.get('user').id, 'status_report.unpublished', 'project', a.project.id, { id: row.id }),
    ]);
    return c.json({ report: reportOut(await db.get(`${SELECT} WHERE r.id = ?`, [row.id])) });
  });

  app.post('/api/projects/:key/status-reports/:id/ai-summary', async (c) => {
    const { a, row, db } = await loadReport(c, 'admin');
    if (row.status !== 'draft') fail(409, 'A published report is read only. Unpublish it to change it.');
    if (!(await aiAvailable(c))) fail(400, 'AI is not configured');
    try {
      const r = await aiComplete(c.env, { system: AI_SUMMARY_SYSTEM, prompt: aiSummaryPrompt(a.project, reportOut(row)), maxTokens: 800 });
      const summary = String(r.text || '')
        .replace(/\s*—\s*/g, ', ')
        .trim()
        .slice(0, 5000);
      if (!summary) fail(502, 'The AI service gave an empty answer');
      return c.json({ summary });
    } catch (e) {
      if (!(e instanceof AiError)) throw e;
      await logAiError(db, e.provider, e.code, 'status report summary');
      fail(502, e.code === 'not_configured' ? 'AI is not configured' : explainAiError(e.code));
    }
  });

  app.delete('/api/projects/:key/status-reports/:id', async (c) => {
    const { a, row, db } = await loadReport(c, 'admin');
    if (row.status !== 'draft') fail(409, 'Only drafts can be deleted. Unpublish the report first.');
    await db.batch([
      { sql: 'DELETE FROM status_reports WHERE id = ?', params: [row.id] },
      audit(c.get('user').id, 'status_report.deleted', 'project', a.project.id, { id: row.id, period: periodLabel(row) }),
    ]);
    return c.json({ ok: true });
  });

  // Portfolio hook: the latest published report's RAG for each project the caller can see (guests: shared only).
  app.get('/api/status-summary', async (c) => {
    const user = c.get('user');
    const v = visibleProjectsSql(user);
    const rows = await c.env.db.all(
      `SELECT r.id, r.project_id, r.rag, r.period_start, r.period_end, r.published_at, p.key, p.name
         FROM status_reports r JOIN projects p ON p.id = r.project_id
        WHERE r.status = 'published' AND p.archived = 0 AND ${v.sql}${isGuest(user) ? ' AND r.shared_with_guests = 1' : ''}
        ORDER BY r.period_end DESC, r.published_at DESC`,
      v.params,
    );
    const seen = new Set();
    const projects = [];
    for (const r of rows) {
      if (seen.has(r.project_id)) continue;
      seen.add(r.project_id);
      const b = reportBrief(r);
      projects.push({
        project: { key: r.key, name: r.name },
        reportId: r.id,
        periodStart: r.period_start,
        periodEnd: r.period_end,
        publishedAt: r.published_at,
        rag: b.rag,
      });
    }
    return c.json({ projects });
  });
}
