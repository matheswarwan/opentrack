// Project status reports: draft computation, RAG suggestions, edit/publish permissions, guests, AI draft, Markdown.
import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser } from './helpers.js';
import { suggestRag, RULES } from '../server/lib/statusReports.js';
import { reportMarkdown, groups } from '../src/statusReport.js';

let ctx, bob, carol, gina, statuses;
const DAY = 864e5;
const dayAgo = (n) => new Date(Date.now() - n * DAY).toISOString();
const dateIn = (n) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const base = '/api/projects/CLI/status-reports';

async function issue(fields) {
  const r = await bob.client.post('/api/issues', { projectKey: 'CLI', ...fields });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.issue;
}
const setRow = (key, sql, params) => ctx.db.run(`UPDATE issues SET ${sql} WHERE key = ?`, [...params, key]);
const statusId = (category) => statuses.find((s) => s.category === category).id;

// CLI: private, Bob's (project admin). Carol is a member, Gina a guest.
beforeEach(async () => {
  ctx = await withAdmin({ PUBLIC_URL: 'https://tracker.example.com' });
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
  gina = await addUser(ctx, { email: 'gina@client.example', name: 'Gina Guest', role: 'guest' });
  await bob.client.post('/api/projects', { key: 'CLI', name: 'Client portal', visibility: 'private' });
  await bob.client.put(`/api/projects/CLI/members/${carol.id}`, { role: 'member' });
  await bob.client.put(`/api/projects/CLI/members/${gina.id}`, { role: 'guest-comment' });
  statuses = (await bob.client.get('/api/projects/CLI')).body.project.statuses;

  const epic = await issue({ type: 'epic', title: 'Login epic' }); // CLI-1
  await issue({ type: 'story', title: 'Login page', parentKey: epic.key, estimateHours: 10 }); // CLI-2 done in the period
  await issue({ title: 'Old work' }); // CLI-3 done 20 days ago
  await issue({ title: 'Search', assigneeId: carol.id }); // CLI-4 in progress
  await issue({ title: 'Next thing', dueDate: dateIn(3) }); // CLI-5 due in the next period
  await issue({ title: 'Late thing', dueDate: dateIn(-3) }); // CLI-6 overdue
  await issue({ type: 'bug', title: 'Crash on save', priority: 'highest' }); // CLI-7 high priority bug
  await issue({ title: 'Waiting on API' }); // CLI-8 blocked by CLI-9
  await issue({ title: 'API contract' }); // CLI-9
  await issue({ type: 'subtask', title: 'Sub of login', parentKey: 'CLI-2' }); // CLI-10 done, sub-tasks are left out
  await bob.client.post('/api/issues/CLI-9/links', { type: 'blocks', targetKey: 'CLI-8' });
  for (const k of ['CLI-2', 'CLI-3', 'CLI-10']) await bob.client.patch(`/api/issues/${k}`, { statusId: statusId('done') });
  await bob.client.patch('/api/issues/CLI-4', { statusId: statusId('in_progress') });
  await setRow('CLI-2', 'resolved_at = ?', [dayAgo(2)]);
  await setRow('CLI-3', 'resolved_at = ?', [dayAgo(20)]);
  // work logs: 2 h in the period, 5 h a month ago
  await carol.client.post('/api/issues/CLI-4/worklogs', { hours: 2, workDate: dateIn(-1) });
  await carol.client.post('/api/issues/CLI-4/worklogs', { hours: 5, workDate: dateIn(-30) });
  // a release past its date, with one issue
  const rel = (await bob.client.post('/api/projects/CLI/releases', { name: '1.0', releaseDate: dateIn(-1) })).body.release;
  await bob.client.patch('/api/issues/CLI-2', { fixVersions: [rel.id] });
  // an internal note that must never show up
  await bob.client.post('/api/issues/CLI-4/comments', { body: 'SECRET-INTERNAL-NOTE', internal: true });
  // in the Trash: left out
  await issue({ title: 'Trashed work', dueDate: dateIn(-5) });
  await bob.client.del('/api/issues/CLI-11');
});

describe('draft computation', () => {
  it('fills done, in progress, next, risks, milestones and time from the period', async () => {
    const r = await bob.client.post(base, {});
    expect(r.status).toBe(201);
    const rep = r.body.report;
    expect(rep).toMatchObject({
      status: 'draft',
      periodEnd: dateIn(0),
      periodStart: dateIn(-6),
      sharedWithGuests: false,
      author: { name: 'Bob' },
    });
    const keys = (s) => rep.sections[s].items.map((i) => i.key);
    expect(keys('done')).toEqual(['CLI-2']); // not CLI-3 (before the period), not the sub-task
    expect(rep.sections.done.items[0].epic).toEqual({ key: 'CLI-1', title: 'Login epic' });
    expect(keys('inProgress')).toEqual(['CLI-4']);
    expect(keys('next')).toEqual(['CLI-5']);
    const risks = Object.fromEntries(rep.sections.risks.items.map((i) => [i.key, i.reasons]));
    expect(risks['CLI-8']).toEqual(['Blocked by CLI-9']);
    expect(risks['CLI-6'][0]).toMatch(/^Overdue/);
    expect(risks['CLI-7']).toEqual(['Highest priority bug']);
    expect(risks['CLI-11']).toBeUndefined(); // Trash
    expect(rep.sections.milestones.items).toEqual([expect.objectContaining({ name: '1.0', overdue: true, done: 1, total: 1 })]);
    expect(rep.sections.time).toMatchObject({ total: 2, items: [{ name: 'Carol', hours: 2 }], hidden: false });
    expect(rep.data.counts).toMatchObject({ done: 1, inProgress: 1, overdue: 1, blocked: 1, highBugs: 1 });
    expect(rep.data.budget).toMatchObject({ estimateHours: 10, loggedHours: 7, progress: 1 });
    // suggested RAG: schedule red (release past its date), quality amber (one high bug)
    expect(rep.rag.schedule).toMatchObject({ suggested: 'red', value: 'red' });
    expect(rep.rag.quality.value).toBe('amber');
    expect(rep.rag.overall.value).toBe('red');
    expect(rep.rag.budget.value).toBe('green');
    expect(JSON.stringify(rep)).not.toContain('SECRET-INTERNAL-NOTE');
  });

  it('takes a custom period, hides time without work logs and checks the period', async () => {
    const r = await bob.client.post(base, { periodStart: dateIn(-25), periodEnd: dateIn(-15) });
    expect(r.body.report.sections.done.items.map((i) => i.key)).toEqual(['CLI-3']);
    expect(r.body.report.sections.time).toMatchObject({ hidden: true, items: [] });
    expect(r.body.report.data.time).toBeNull();
    expect((await bob.client.post(base, { periodStart: dateIn(0), periodEnd: dateIn(-3) })).status).toBe(400);
    expect((await bob.client.post(base, { periodStart: dateIn(-200), periodEnd: dateIn(0) })).status).toBe(400);
  });

  it('uses the active sprint burndown and scope added after the start', async () => {
    const s = (await bob.client.post('/api/projects/CLI/sprints', { name: 'Sprint 1' })).body.sprint;
    await bob.client.patch('/api/issues/CLI-8', { sprintId: s.id });
    await bob.client.patch('/api/issues/CLI-9', { sprintId: s.id });
    await bob.client.post(`/api/sprints/${s.id}/start`, { startDate: dateIn(-5), endDate: dateIn(5) });
    // backdate: the issues existed before the start, CLI-8 and CLI-9 joined the sprint before it started
    await ctx.db.run(`UPDATE audit_log SET created_at = ? WHERE action = 'sprint.started'`, [dayAgo(5)]);
    await ctx.db.run('UPDATE issues SET created_at = ?', [dayAgo(10)]);
    await ctx.db.run(
      `UPDATE issue_history SET created_at = ? WHERE field = 'sprint' AND issue_id IN (SELECT id FROM issues WHERE key IN ('CLI-8', 'CLI-9'))`,
      [dayAgo(6)],
    );
    await bob.client.patch('/api/issues/CLI-5', { sprintId: s.id }); // added after the start
    const rep = (await bob.client.post(base, {})).body.report;
    expect(rep.data.burndown).toMatchObject({ unit: 'issues', committed: 2, added: 1, remaining: 3 });
    expect(rep.data.burndown.behind).toBeGreaterThan(RULES.schedule.behindRed);
    expect(rep.rag.scope.value).toBe('amber'); // 50% added: over 20%, not over 50%
  });
});

describe('RAG suggestion rules', () => {
  const data = (counts = {}, extra = {}) => ({
    counts: { overdue: 0, blocked: 0, highBugs: 0, ...counts },
    burndown: null,
    budget: null,
    overdueReleases: [],
    ...extra,
  });
  it('is green with nothing wrong and has no budget without estimates', () => {
    const r = suggestRag(data());
    expect(r.overall.value).toBe('green');
    expect(r.budget).toBeUndefined();
    expect(Object.keys(r)).toEqual(['overall', 'scope', 'schedule', 'quality']);
  });
  it('rates schedule from overdue, blocked and the burndown', () => {
    expect(suggestRag(data({ overdue: 1 })).schedule.value).toBe('amber');
    expect(suggestRag(data({ overdue: RULES.schedule.overdueRed })).schedule.value).toBe('red');
    expect(suggestRag(data({ blocked: 2 })).schedule.value).toBe('amber');
    const bd = (behind) => ({ sprint: { name: 'S1' }, unit: 'points', committed: 10, added: 0, behind, scopeAdded: 0 });
    expect(suggestRag(data({}, { burndown: bd(0.05) })).schedule.value).toBe('green');
    expect(suggestRag(data({}, { burndown: bd(0.2) })).schedule.value).toBe('amber');
    expect(suggestRag(data({}, { burndown: bd(0.3) })).schedule.value).toBe('red');
  });
  it('rates quality, scope and budget, and overall is the worst area', () => {
    expect(suggestRag(data({ highBugs: 3 })).quality.value).toBe('red');
    const scope = (scopeAdded) =>
      suggestRag(data({}, { burndown: { sprint: { name: 'S1' }, unit: 'points', committed: 10, added: 5, behind: 0, scopeAdded } })).scope
        .value;
    expect([scope(0.1), scope(0.3), scope(0.6)]).toEqual(['green', 'amber', 'red']);
    const budget = (burn, progress) =>
      suggestRag(data({}, { budget: { estimateHours: 100, loggedHours: burn * 100, burn, progress } })).budget.value;
    expect([budget(0.5, 0.5), budget(0.6, 0.45), budget(0.8, 0.5), budget(1.1, 1)]).toEqual(['green', 'amber', 'red', 'red']);
    const r = suggestRag(data({ highBugs: 1 }, { budget: { estimateHours: 10, loggedHours: 2, burn: 0.2, progress: 0.2 } }));
    expect(r.overall).toMatchObject({ value: 'amber', why: ['Quality is Amber'] });
  });
});

describe('edit, publish and permissions', () => {
  it('lets project admins write and members read; published reports are read only', async () => {
    expect((await carol.client.post(base, {})).status).toBe(403);
    const id = (await bob.client.post(base, {})).body.report.id;
    // members read drafts
    expect((await carol.client.get(`${base}/${id}`)).body.report.status).toBe('draft');
    expect((await carol.client.get(base)).body.reports).toHaveLength(1);
    expect((await carol.client.patch(`${base}/${id}`, { summary: 'x' })).status).toBe(403);
    // edits: summary, sections (remove and reorder), RAG override needs a reason
    const rep = (await bob.client.get(`${base}/${id}`)).body.report;
    const risks = [...rep.sections.risks.items].reverse().slice(0, 2);
    let r = await bob.client.patch(`${base}/${id}`, {
      summary: 'Good week.',
      sections: { risks: { items: risks, text: 'Client sign-off pending' }, decisions: { items: [{ text: 'Pick the SSO provider' }] } },
    });
    expect(r.status).toBe(200);
    expect(r.body.report.sections.risks.items.map((i) => i.key)).toEqual(risks.map((i) => i.key));
    expect(r.body.report.sections.decisions.items).toEqual([{ text: 'Pick the SSO provider' }]);
    expect(r.body.report.sections.done.items).toHaveLength(1); // untouched
    expect((await bob.client.patch(`${base}/${id}`, { rag: { overall: { value: 'amber' } } })).status).toBe(400);
    expect((await bob.client.patch(`${base}/${id}`, { rag: { overall: { value: 'purple', reason: 'x' } } })).status).toBe(400);
    expect((await bob.client.patch(`${base}/${id}`, { sections: { nope: {} } })).status).toBe(400);
    r = await bob.client.patch(`${base}/${id}`, { rag: { overall: { value: 'amber', reason: 'Release date agreed with the client' } } });
    expect(r.body.report.rag.overall).toMatchObject({ suggested: 'red', value: 'amber', reason: 'Release date agreed with the client' });

    // publish: Carol is notified, Gina (not shared) is not
    expect((await carol.client.post(`${base}/${id}/publish`)).status).toBe(403);
    r = await bob.client.post(`${base}/${id}/publish`);
    expect(r.body).toMatchObject({ report: { status: 'published' }, notified: 1 });
    expect(r.body.report.publishedAt).toBeTruthy();
    expect((await bob.client.post(`${base}/${id}/publish`)).status).toBe(409);
    const notes = (await carol.client.get('/api/notifications')).body.notifications;
    expect(notes[0]).toMatchObject({ type: 'status_report', link: `/projects/CLI/status/${id}`, issueKey: null });
    expect(notes[0].message).toContain('Overall: Amber');
    expect((await gina.client.get('/api/notifications')).body.notifications.filter((n) => n.type === 'status_report')).toHaveLength(0);
    expect((await bob.client.patch(`${base}/${id}`, { summary: 'changed' })).status).toBe(409);
    expect((await bob.client.del(`${base}/${id}`)).status).toBe(409);

    // unpublish by project admins only, then delete the draft
    expect((await carol.client.post(`${base}/${id}/unpublish`)).status).toBe(403);
    expect((await bob.client.post(`${base}/${id}/unpublish`)).body.report).toMatchObject({ status: 'draft', publishedAt: null });
    expect((await carol.client.del(`${base}/${id}`)).status).toBe(403);
    expect((await bob.client.del(`${base}/${id}`)).status).toBe(200);
    expect((await bob.client.get(`${base}/${id}`)).status).toBe(404);
    const audit = await ctx.db.all(`SELECT action FROM audit_log WHERE action LIKE 'status_report.%' ORDER BY created_at`);
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['status_report.created', 'status_report.published', 'status_report.unpublished', 'status_report.deleted']),
    );
  });

  it('guests see only shared published reports, without the data snapshot or internal sections', async () => {
    const id = (await bob.client.post(base, {})).body.report.id;
    expect((await gina.client.get(base)).body.reports).toEqual([]);
    expect((await gina.client.get(`${base}/${id}`)).status).toBe(404); // a draft
    await bob.client.post(`${base}/${id}/publish`);
    expect((await gina.client.get(`${base}/${id}`)).status).toBe(404); // published, not shared
    expect((await gina.client.get('/api/status-summary')).body.projects).toEqual([]);
    await bob.client.post(`${base}/${id}/unpublish`);
    await bob.client.patch(`${base}/${id}`, { sharedWithGuests: true, sections: { time: { internal: true } } });
    expect((await gina.client.patch(`${base}/${id}`, { summary: 'x' })).status).toBe(403);
    const pub = await bob.client.post(`${base}/${id}/publish`);
    expect(pub.body.notified).toBe(2); // Carol and Gina
    const g = (await gina.client.get(`${base}/${id}`)).body;
    expect(g.report.data).toBeUndefined();
    expect(g.report.sections.time).toBeUndefined();
    expect(g.report.sections.done.items).toHaveLength(1);
    expect(g.canAdmin).toBe(false);
    expect(JSON.stringify(g)).not.toContain('SECRET-INTERNAL-NOTE');
    expect((await gina.client.get(base)).body.reports).toHaveLength(1);
    const note = (await gina.client.get('/api/notifications')).body.notifications.find((n) => n.type === 'status_report');
    expect(note.link).toBe(`/projects/CLI/status/${id}`);
    expect((await gina.client.get('/api/me')).body.unreadNotifications).toBeGreaterThan(0);
    // a second draft stays hidden from the guest
    const draft = (await bob.client.post(base, {})).body.report.id;
    expect((await gina.client.get(`${base}/${draft}`)).status).toBe(404);
    expect((await gina.client.get(base)).body.reports.map((r) => r.id)).toEqual([id]);
    // portfolio hook
    const sum = (await gina.client.get('/api/status-summary')).body.projects;
    expect(sum).toEqual([
      expect.objectContaining({
        project: { key: 'CLI', name: 'Client portal' },
        reportId: id,
        rag: expect.objectContaining({ overall: 'red' }),
      }),
    ]);
    expect((await carol.client.get('/api/status-summary')).body.projects).toHaveLength(1);
    // a guest removed from the project loses the notice
    await bob.client.del(`/api/projects/CLI/members/${gina.id}`);
    expect((await gina.client.get('/api/notifications')).body.notifications.find((n) => n.type === 'status_report')).toBeUndefined();
  });

  it('Markdown for Copy as text and the print page', async () => {
    const id = (await bob.client.post(base, {})).body.report.id;
    await bob.client.patch(`${base}/${id}`, {
      summary: 'A good week.',
      sections: { decisions: { items: [{ text: 'Pick the SSO provider' }] } },
    });
    const rep = (await bob.client.get(`${base}/${id}`)).body.report;
    const md = reportMarkdown(rep, { name: 'Client portal', key: 'CLI' });
    expect(md).toContain('# Status report: Client portal');
    expect(md).toMatch(/\| Overall \| Red \|/);
    expect(md).toContain('## Summary\n\nA good week.');
    expect(md).toContain('## Done this period\n\n- CLI-2 Login page');
    expect(md).toContain('## Decisions needed\n\n- Pick the SSO provider');
    expect(md).toContain('## Time logged this period: 2 h');
    expect(md).toContain('1.0: unreleased');
    expect(groups('done', [{ key: 'A-1', epic: { key: 'A-9', title: 'E' } }, { key: 'A-2' }]).map((g) => g.title)).toEqual([
      'A-9 E',
      'Other work',
    ]);
  });
});

describe('Draft with AI', () => {
  function fakeAi() {
    const calls = [];
    const fetch = async (url, init = {}) => {
      calls.push({ url: String(url), body: init.body });
      return Response.json({
        candidates: [{ content: { parts: [{ text: 'The login page shipped — search is next.' }] }, finishReason: 'STOP' }],
      });
    };
    return { calls, fetch };
  }

  it('drafts the summary with the provider, without internal notes', async () => {
    const ai = fakeAi();
    Object.assign(ctx.env, { fetch: ai.fetch, AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'gem-key', AI_RETRY_MS: 0 });
    const id = (await bob.client.post(base, {})).body.report.id;
    expect((await bob.client.get(base)).body.aiAvailable).toBe(false); // channel AI off for the workspace
    expect((await bob.client.post(`${base}/${id}/ai-summary`)).status).toBe(400);
    await ctx.admin.patch('/api/admin/settings', { channelAi: true });
    expect((await bob.client.get(base)).body.aiAvailable).toBe(true);
    expect((await carol.client.get(base)).body.aiAvailable).toBe(false);
    expect((await carol.client.post(`${base}/${id}/ai-summary`)).status).toBe(403);
    const r = await bob.client.post(`${base}/${id}/ai-summary`);
    expect(r.status).toBe(200);
    expect(r.body.summary).toBe('The login page shipped, search is next.');
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0].body).toContain('Login page');
    expect(ai.calls[0].body).not.toContain('SECRET-INTERNAL-NOTE');
    expect((await bob.client.get(`${base}/${id}`)).body.report.summary).toBe(''); // not saved until the PM saves
  });

  it('says AI is not configured without a provider', async () => {
    await ctx.admin.patch('/api/admin/settings', { channelAi: true });
    const id = (await bob.client.post(base, {})).body.report.id;
    expect((await bob.client.get(base)).body.aiAvailable).toBe(false);
    const r = await bob.client.post(`${base}/${id}/ai-summary`);
    expect(r).toMatchObject({ status: 400, body: { error: 'AI is not configured' } });
  });
});

describe('backups', () => {
  it('full backups and project exports include status reports', async () => {
    const id = (await bob.client.post(base, {})).body.report.id;
    const full = await ctx.admin.get('/api/admin/backup');
    const b = typeof full.body === 'string' ? JSON.parse(full.body) : full.body;
    expect(b.tables.status_reports).toEqual([expect.objectContaining({ id, status: 'draft' })]);
    expect(b.tableOrder.indexOf('status_reports')).toBeGreaterThan(b.tableOrder.indexOf('projects'));
    const p = await bob.client.get('/api/projects/CLI/export.json');
    const pb = typeof p.body === 'string' ? JSON.parse(p.body) : p.body;
    expect(pb.tables.status_reports).toHaveLength(1);
  });
});
