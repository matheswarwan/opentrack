// RAID log: entries, risk scores, history, rights (guests see nothing), filters, heat map, CSV, issue links,
// owner notifications, status report Top risks, review-date reminders, MCP list_raid and backups.
import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser } from './helpers.js';
import { runDueJobs, resetJobThrottle } from '../server/lib/jobs.js';
import { localMidnight } from '../server/lib/time.js';
import { insertRows } from '../server/db/sql.js';
import { reportMarkdown } from '../src/statusReport.js';

const THU_0830 = localMidnight('2026-11-19', 'America/Vancouver') + 8.5 * 3600e3;
const base = '/api/projects/CLI/raid';
let ctx, bob, carol, vic, gina, dave;

const ok = (r, status = 200) => {
  if (r.status !== status) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const create = async (who, fields, status = 201) => ok(await who.client.post(base, fields), status);

// CLI: private, Bob's (project admin). Carol is a member, Vic a project viewer, Gina a guest, Dave not a member.
beforeEach(async () => {
  resetJobThrottle();
  ctx = await withAdmin({ now: () => THU_0830, PUBLIC_URL: 'https://tracker.example.com' });
  await ctx.db.run(`UPDATE jobs SET enabled = 0 WHERE name IN ('trash_purge', 'backup', 'recurring', 'weekly_digest')`);
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
  vic = await addUser(ctx, { email: 'vic@example.com', name: 'Vic' });
  gina = await addUser(ctx, { email: 'gina@client.example', name: 'Gina Guest', role: 'guest' });
  dave = await addUser(ctx, { email: 'dave@example.com', name: 'Dave' });
  await bob.client.post('/api/projects', { key: 'CLI', name: 'Client portal', visibility: 'private' });
  await bob.client.put(`/api/projects/CLI/members/${carol.id}`, { role: 'member' });
  await bob.client.put(`/api/projects/CLI/members/${vic.id}`, { role: 'viewer' });
  await bob.client.put(`/api/projects/CLI/members/${gina.id}`, { role: 'guest-edit' });
  for (const t of ['Login', 'Search']) await bob.client.post('/api/issues', { projectKey: 'CLI', title: t }); // CLI-1, CLI-2
  await bob.client.post('/api/projects', { key: 'OPS', name: 'Ops' });
  await bob.client.post('/api/issues', { projectKey: 'OPS', title: 'Elsewhere' }); // OPS-1
});

describe('entries', () => {
  it('creates a risk with a score, numbers entries per project and keeps a history', async () => {
    const r = (
      await create(carol, {
        type: 'risk',
        title: 'API vendor late',
        description: '**Big**',
        probability: 4,
        impact: 4,
        mitigation: 'Weekly call',
        contingency: 'Mock API',
        ownerId: bob.id,
        reviewDate: '2026-11-25',
        issueKeys: ['cli-1'],
      })
    ).entry;
    expect(r).toMatchObject({
      ref: 'RAID-1',
      type: 'risk',
      status: 'open',
      score: 16,
      active: true,
      owner: { name: 'Bob' },
      links: [{ key: 'CLI-1', title: 'Login', done: false }],
      createdBy: { name: 'Carol' },
    });
    const d = (
      await create(carol, {
        type: 'decision',
        title: 'Use Postgres',
        decidedBy: 'Client CTO',
        decidedOn: '2026-11-10',
        rationale: 'Cloud SQL',
        probability: 3,
      })
    ).entry;
    expect(d).toMatchObject({ ref: 'RAID-2', status: 'proposed', probability: null, score: null, decidedBy: 'Client CTO' });

    const p = ok(await carol.client.patch(`${base}/${r.id}`, { impact: 2, status: 'monitoring', issueKeys: ['CLI-1', 'CLI-2'] }));
    expect(p.entry).toMatchObject({ score: 8, status: 'monitoring', links: [{ key: 'CLI-1' }, { key: 'CLI-2' }] });
    expect(p.changed.sort()).toEqual(['impact', 'links', 'status']);
    // nothing changed: no history, no update
    expect(ok(await carol.client.patch(`${base}/${r.id}`, { impact: 2 })).changed).toEqual([]);

    const one = ok(await carol.client.get(`${base}/${r.id}`));
    expect(one.history.map((h) => h.field)).toEqual(['created', 'status', 'impact', 'links']);
    expect(one.history.find((h) => h.field === 'impact')).toMatchObject({ from: '4', to: '2', actor: { name: 'Carol' }, label: 'Impact' });
    expect(one.history.find((h) => h.field === 'links')).toMatchObject({ from: 'CLI-1', to: 'CLI-1 CLI-2' });

    // a type change drops the fields of the old type and resets a status the new type does not have
    const t = ok(await carol.client.patch(`${base}/${r.id}`, { type: 'issue' })).entry;
    expect(t).toMatchObject({ type: 'issue', status: 'monitoring', probability: null, score: null, mitigation: '' });
    const dd = ok(await carol.client.patch(`${base}/${d.id}`, { type: 'assumption' })).entry;
    expect(dd).toMatchObject({ status: 'open', decidedBy: '' });

    const audit = await ctx.db.all(`SELECT action FROM audit_log WHERE action LIKE 'raid.%' ORDER BY created_at`);
    expect(audit.map((a) => a.action)).toEqual(['raid.created', 'raid.created', 'raid.updated', 'raid.updated', 'raid.updated']);
  });

  it('checks input', async () => {
    const bad = async (f, msg) => expect((await carol.client.post(base, f)).body.error).toContain(msg);
    await bad({ title: 'x' }, 'Type');
    await bad({ type: 'risk' }, 'Title');
    await bad({ type: 'risk', title: 'x', probability: 6 }, 'Probability');
    await bad({ type: 'risk', title: 'x', impact: 2.5 }, 'whole number');
    await bad({ type: 'risk', title: 'x', status: 'agreed' }, 'Status of a risk');
    await bad({ type: 'decision', title: 'x', status: 'open' }, 'Status of a decision');
    await bad({ type: 'issue', title: 'x', reviewDate: 'soon' }, 'YYYY-MM-DD');
    await bad({ type: 'issue', title: 'x', issueKeys: ['OPS-1'] }, 'Not issues of this project: OPS-1');
    await bad({ type: 'issue', title: 'x', ownerId: gina.id }, 'Guests cannot own');
    await bad({ type: 'issue', title: 'x', ownerId: dave.id }, 'cannot see this project');
    await bad({ type: 'issue', title: 'x', issueKeys: Array.from({ length: 41 }, (_, i) => `CLI-${i}`) }, 'At most 40');
  });

  it('notifies the owner when assigned, not when they assign themselves', async () => {
    const e = (await create(bob, { type: 'issue', title: 'Server down', ownerId: carol.id })).entry;
    await create(carol, { type: 'issue', title: 'Mine', ownerId: carol.id });
    let n = await ctx.db.all(`SELECT * FROM notifications WHERE user_id = ? AND type = 'raid_owner'`, [carol.id]);
    expect(n).toHaveLength(1);
    expect(n[0].message).toBe('Bob made you the owner of CLI RAID-1 (issue): Server down');
    expect(n[0].link).toBe(`/projects/CLI/raid?entry=${e.id}`);
    await bob.client.patch(`${base}/${e.id}`, { ownerId: bob.id });
    await carol.client.patch(`${base}/${e.id}`, { ownerId: bob.id, title: 'Server down again' });
    expect(await ctx.db.all(`SELECT * FROM notifications WHERE user_id = ? AND type = 'raid_owner'`, [bob.id])).toHaveLength(0); // already owner
    await carol.client.patch(`${base}/${e.id}`, { ownerId: null });
    await carol.client.patch(`${base}/${e.id}`, { ownerId: bob.id });
    n = await ctx.db.all(`SELECT * FROM notifications WHERE user_id = ? AND type = 'raid_owner'`, [bob.id]);
    expect(n).toHaveLength(1);
  });
});

describe('rights', () => {
  it('members edit, viewers read, project admins delete, guests and outsiders get 404', async () => {
    const e = (await create(carol, { type: 'risk', title: 'Risk', probability: 2, impact: 3, issueKeys: ['CLI-1'] })).entry;
    expect(ok(await vic.client.get(base))).toMatchObject({ canEdit: false, canAdmin: false, total: 1 });
    expect((await vic.client.post(base, { type: 'risk', title: 'No' })).status).toBe(403);
    expect((await vic.client.patch(`${base}/${e.id}`, { title: 'No' })).status).toBe(403);
    expect((await carol.client.del(`${base}/${e.id}`)).status).toBe(403);
    for (const path of [base, `${base}/${e.id}`, `/api/projects/CLI/raid.csv`, '/api/issues/CLI-1/raid']) {
      expect((await gina.client.get(path)).status, path).toBe(404);
      expect((await dave.client.get(path)).status, path).toBe(404);
    }
    expect((await gina.client.post(base, { type: 'risk', title: 'No' })).status).toBe(404);
    expect(ok(await bob.client.del(`${base}/${e.id}`))).toEqual({ ok: true });
    expect((await bob.client.get(`${base}/${e.id}`)).status).toBe(404);
    expect(await ctx.db.all('SELECT * FROM raid_links')).toEqual([]);
    expect(await ctx.db.get(`SELECT details FROM audit_log WHERE action = 'raid.deleted'`)).toBeTruthy();
  });

  it('archived projects are read only', async () => {
    await create(carol, { type: 'risk', title: 'Risk' });
    await bob.client.patch('/api/projects/CLI', { archived: true });
    expect((await carol.client.post(base, { type: 'risk', title: 'No' })).body.error).toBe('This project is archived');
  });
});

describe('list, heat map, CSV and issue detail', () => {
  beforeEach(async () => {
    await create(carol, { type: 'risk', title: 'High', probability: 5, impact: 4, ownerId: carol.id, reviewDate: '2026-11-01' }); // RAID-1, overdue
    await create(carol, { type: 'risk', title: 'Mid', probability: 3, impact: 3, ownerId: bob.id }); // RAID-2
    await create(carol, { type: 'risk', title: 'Closed high', probability: 5, impact: 5, status: 'closed', reviewDate: '2026-11-01' }); // RAID-3
    await create(carol, { type: 'assumption', title: 'Client has data', issueKeys: ['CLI-2'] }); // RAID-4
    await create(carol, { type: 'decision', title: 'Go with Vue', status: 'agreed', issueKeys: ['CLI-2'] }); // RAID-5
  });

  it('filters, sorts and counts', async () => {
    const all = ok(await carol.client.get(base));
    expect(all.counts).toEqual({ risk: 3, assumption: 1, issue: 0, decision: 1 });
    expect(all.overdue).toBe(1); // the closed one is not overdue
    expect(all.heat[4][3]).toBe(1); // probability 5, impact 4
    expect(all.heat[4][4]).toBe(0); // closed risks are left out
    expect(all.heat[2][2]).toBe(1);
    expect(all.entries.map((e) => e.ref).slice(0, 3)).toEqual(['RAID-3', 'RAID-1', 'RAID-2']); // score, highest first
    const refs = async (q) => ok(await carol.client.get(`${base}?${q}`)).entries.map((e) => e.ref);
    expect(await refs('type=risk&status=active')).toEqual(['RAID-1', 'RAID-2']);
    expect(await refs('owner=me')).toEqual(['RAID-1']);
    expect(await refs('owner=none&type=risk')).toEqual(['RAID-3']);
    expect(await refs('overdue=1')).toEqual(['RAID-1']);
    expect(await refs('probability=3&impact=3')).toEqual(['RAID-2']);
    expect(await refs('sort=ref&dir=asc')).toEqual(['RAID-1', 'RAID-2', 'RAID-3', 'RAID-4', 'RAID-5']);
    expect(await refs('sort=title')).toEqual(['RAID-4', 'RAID-3', 'RAID-5', 'RAID-1', 'RAID-2']);
    expect(await refs('q=vue')).toEqual(['RAID-5']);
  });

  it('exports CSV and lists entries on the issue', async () => {
    const csv = await carol.client.get(`/api/projects/CLI/raid.csv?type=risk`);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    const lines = csv.body.split('\n');
    expect(lines[0]).toMatch(/^Ref,Type,Title,Status,Owner,Review date,Probability,Impact,Score/);
    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatch(/^RAID-3,Risk,Closed high,closed,,2026-11-01,5,5,25/);
    const onIssue = ok(await vic.client.get('/api/issues/CLI-2/raid'));
    expect(onIssue.entries.map((e) => `${e.ref} ${e.type}`)).toEqual(['RAID-4 assumption', 'RAID-5 decision']);
    // an issue in the Trash drops out of the links
    await bob.client.del('/api/issues/CLI-2');
    expect(ok(await carol.client.get(base)).entries.find((e) => e.ref === 'RAID-4').links).toEqual([]);
  });

  it('status report draft lists open risks with a score of 12 or more, as an internal section', async () => {
    for (let i = 0; i < 5; i++) await create(carol, { type: 'risk', title: `Extra ${i}`, probability: 3, impact: 4, status: 'monitoring' });
    const rep = ok(await bob.client.post('/api/projects/CLI/status-reports', {}), 201).report;
    const top = rep.sections.topRisks;
    expect(top.internal).toBe(true);
    expect(top.items).toHaveLength(5);
    expect(top.items[0]).toMatchObject({ title: 'RAID-1 High', why: 'score 20 (probability 5, impact 4), owner Carol, review 2026-11-01' });
    expect(top.items.map((x) => x.title)).not.toContain('RAID-3 Closed high');
    expect(top.items.map((x) => x.title)).not.toContain('RAID-2 Mid'); // score 9
    expect(reportMarkdown(rep, { name: 'Client portal' })).toContain('## Top risks');
    // shared with guests: internal sections stay hidden
    await bob.client.patch(`/api/projects/CLI/status-reports/${rep.id}`, { sharedWithGuests: true });
    await bob.client.post(`/api/projects/CLI/status-reports/${rep.id}/publish`);
    expect(ok(await gina.client.get(`/api/projects/CLI/status-reports/${rep.id}`)).report.sections.topRisks).toBeUndefined();
  });

  it('due-date reminders include RAID entries due for review', async () => {
    const r = await runDueJobs({ env: ctx.env, req: { url: 'https://tracker.example.com/api/x' } });
    expect(r).toMatchObject({ ran: 'due_reminders', status: 'done' });
    const n = await ctx.db.all(`SELECT message FROM notifications WHERE user_id = ? AND type = 'due'`, [carol.id]);
    expect(n.map((x) => x.message)).toEqual(['1 RAID entry to review: CLI RAID-1 (overdue 18 days)']);
    expect(await ctx.db.all(`SELECT message FROM notifications WHERE user_id = ? AND type = 'due'`, [bob.id])).toEqual([]); // no review date
  });

  it('MCP list_raid and backups', async () => {
    const token = ok(await carol.client.post('/api/me/tokens', { name: 'AI' }), 201).token;
    const res = await ctx.app.request(
      'http://t.example/mcp',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'list_raid', arguments: { project: 'cli', type: 'risk', status: 'active' } },
        }),
      },
      ctx.env,
    );
    const out = JSON.parse((await res.json()).result.content[0].text);
    expect(out).toMatchObject({
      project: 'CLI',
      overdue: 1,
      entries: [
        { ref: 'RAID-1', score: 20, owner: 'Carol', review: '2026-11-01' },
        { ref: 'RAID-2', score: 9 },
      ],
    });

    const full = await ctx.admin.get('/api/admin/backup');
    const b = typeof full.body === 'string' ? JSON.parse(full.body) : full.body;
    expect(b.schema).toBe('0033_security.sql');
    expect(b.tables.raid_entries).toHaveLength(5);
    expect(b.tables.raid_links).toHaveLength(2);
    expect(b.tables.raid_history).toHaveLength(5);
    const p = await bob.client.get('/api/projects/CLI/export.json');
    const pb = typeof p.body === 'string' ? JSON.parse(p.body) : p.body;
    expect(pb.tables.raid_entries).toHaveLength(5);
    expect(pb.tables.raid_links).toHaveLength(2);
    expect(pb.tables.users.map((u) => u.name)).toContain('Carol');
  });
});

describe('insertRows', () => {
  it('keeps each statement at 80 bound values or fewer', () => {
    const rows = Array.from({ length: 30 }, (_, i) => [i, 'a', 'b', 'c', 'd', 'e', 'f']);
    const st = insertRows('raid_history', ['id', 'raid_id', 'actor_id', 'field', 'old_value', 'new_value', 'created_at'], rows);
    expect(st).toHaveLength(3);
    expect(st.every((s) => s.params.length <= 80)).toBe(true);
    expect(st.reduce((a, s) => a + s.params.length, 0)).toBe(210);
  });
});
