// Project templates: built-ins, saving a project as a template, applying, access rules, statement budget, backups.
import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser } from './helpers.js';
import { readBody, relOffset, lit, insertLiteralRows } from '../server/lib/projectTemplates.js';
import { BUILTINS } from '../server/lib/projectTemplates/builtins.js';
import { addDays } from '../server/lib/time.js';
import { BACKUP_SCHEMA } from '../server/lib/backup.js';

const START = '2026-12-07'; // a Monday
const at = (rel) => addDays(START, relOffset(rel));

function countingDb(db) {
  let n = 0;
  const wrap =
    (fn) =>
    async (...a) => {
      n++;
      return fn(...a);
    };
  const counted = {
    ...db,
    all: wrap(db.all.bind(db)),
    get: wrap(db.get.bind(db)),
    run: wrap(db.run.bind(db)),
    batch: async (s) => {
      n += s.length;
      return db.batch(s);
    },
  };
  return {
    counted,
    reset: () => {
      n = 0;
    },
    get count() {
      return n;
    },
  };
}

let ctx;
let bob;
let carol;
beforeEach(async () => {
  ctx = await withAdmin();
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
});

const issuesOf = async (c, key) => (await c.get(`/api/issues?project=${key}&limit=1000`)).body.issues;

describe('relative dates and literals', () => {
  it('counts day N from the start date and week N as its fifth day', () => {
    expect(at('day 1')).toBe('2026-12-07');
    expect(at('day 10')).toBe('2026-12-16');
    expect(at('week 1')).toBe('2026-12-11'); // Friday of the first week
    expect(at('week 6')).toBe('2027-01-15');
    expect(() => relOffset('day 0')).toThrow();
    expect(() => relOffset('next Tuesday')).toThrow();
  });

  it('only writes safe values as SQL literals and binds the rest', () => {
    expect(lit('2026-12-07T10:00:00.000Z')).toBe(`'2026-12-07T10:00:00.000Z'`);
    expect(lit(null)).toBe('NULL');
    expect(() => lit(`x'); DROP TABLE users; --`)).toThrow();
    expect(() => lit('a b')).toThrow();
    const rows = Array.from({ length: 100 }, (_, i) => [`id-${i}`, { bind: `Title ${i}` }, { bind: null }]);
    const stmts = insertLiteralRows('t', ['id', 'title', 'description'], rows);
    expect(stmts.length).toBe(3); // 40 rows at most per statement
    for (const s of stmts) expect(s.params.length).toBeLessThanOrEqual(90);
  });

  it('every built-in template is valid', () => {
    for (const t of BUILTINS) expect(() => readBody(t.body), t.name).not.toThrow();
  });
});

describe('listing', () => {
  it('lists the built-ins with what they set up', async () => {
    const r = await bob.client.get('/api/project-templates');
    expect(r.status).toBe(200);
    const sf = r.body.templates.find((t) => t.id === 'builtin:salesforce');
    expect(sf).toMatchObject({ builtin: true, name: 'Salesforce implementation' });
    expect(sf.summary).toMatchObject({ epics: 6, workflowRules: true, sprint: 'Sprint 1' });
    expect(sf.summary.stories + sf.summary.tasks).toBe(18);
    expect(sf.summary.fields).toEqual(['Client', 'Environment', 'Cloud']);
    expect(r.body.templates.map((t) => t.id)).toEqual(
      expect.arrayContaining(['builtin:marketing-cloud', 'builtin:support', 'builtin:kanban']),
    );
    expect(r.body.roles.lead).toBe('Project lead');
  });
});

describe('applying the built-ins', () => {
  it('Salesforce implementation: statuses, workflow, fields, components, templates, recurring, issues, sprint', async () => {
    const r = await bob.client.post('/api/projects', {
      key: 'ACME',
      name: 'Acme Sales Cloud',
      templateId: 'builtin:salesforce',
      startDate: START,
      leadId: carol.id,
    });
    expect(r.status).toBe(201);
    expect(r.body.template.summary).toMatchObject({ epics: 6, components: 7, workflowRules: true });
    const p = r.body.project;
    expect(p.statuses.map((s) => [s.name, s.category])).toEqual([
      ['To Do', 'todo'],
      ['In Progress', 'in_progress'],
      ['In Review', 'in_progress'],
      ['Client Review', 'in_progress'],
      ['Done', 'done'],
    ]);
    expect(p.statuses[1].wipLimit).toBe(8);
    const sid = (n) => p.statuses.find((s) => s.name === n).id;

    const fields = (await bob.client.get('/api/projects/ACME/fields')).body.fields;
    expect(fields.map((f) => [f.name, f.type])).toEqual([
      ['Client', 'text'],
      ['Environment', 'select'],
      ['Cloud', 'multiselect'],
    ]);
    const env = fields.find((f) => f.name === 'Environment');
    expect(env.options.map((o) => o.name)).toEqual(['Dev', 'QA', 'UAT', 'Prod']);

    const wf = (await bob.client.get('/api/projects/ACME/workflow')).body.workflow;
    expect(wf.statuses[sid('In Review')].required).toEqual(['assignee']);
    expect(wf.statuses[sid('Client Review')]).toMatchObject({ required: [`cf:${env.id}`], actions: { addLabels: ['client-review'] } });

    const comps = (await bob.client.get('/api/projects/ACME/components')).body.components;
    expect(comps).toHaveLength(7);
    const tpls = (await bob.client.get('/api/projects/ACME/templates')).body.templates;
    const uat = tpls.find((t) => t.name === 'UAT bug');
    const uatOption = env.options.find((o) => o.name === 'UAT').id;
    expect(uat).toMatchObject({ type: 'bug', titlePrefix: '[UAT] ', priority: 'high', labels: ['uat'], fields: { [env.id]: uatOption } });

    const rules = (await bob.client.get('/api/projects/ACME/recurring')).body.rules;
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      name: 'Weekly status report',
      schedule: { freq: 'weekly', weekdays: [5] },
      startDate: START,
      assignee: { id: carol.id },
    });

    const issues = await issuesOf(bob.client, 'ACME');
    expect(issues).toHaveLength(24);
    const by = (t) => issues.find((i) => i.title === t);
    expect(by('Discovery')).toMatchObject({ type: 'epic', dueDate: '2026-12-16', status: { name: 'To Do' } });
    expect(by('Test and UAT').dueDate).toBe(at('week 10'));
    expect(by('Hypercare').dueDate).toBe('2027-03-05');
    expect(by('Requirements workshops and sign-off')).toMatchObject({
      type: 'story',
      parent: { key: by('Discovery').key },
      dueDate: '2026-12-16',
      sprint: { name: 'Sprint 1' },
    });
    expect(by('Kick-off meeting and stakeholder list').assignee.id).toBe(carol.id); // role 'lead'
    expect(by('Build integrations').sprint).toBe(null);
    expect(issues.map((i) => i.number).sort((a, b) => a - b)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));

    const sprints = (await bob.client.get('/api/projects/ACME/sprints')).body.sprints;
    expect(sprints).toEqual([expect.objectContaining({ name: 'Sprint 1', state: 'future', startDate: START, endDate: '2026-12-20' })]);

    // the next issue continues the numbering
    const next = await bob.client.post('/api/issues', { projectKey: 'ACME', title: 'Extra' });
    expect(next.body.issue.key).toBe('ACME-25');

    // the workflow rules are live: Client Review needs the Environment
    const story = by('Integration design');
    const move = await bob.client.patch(`/api/issues/${story.key}`, { statusId: sid('Client Review') });
    expect(move.status).toBe(400);
    const ok = await bob.client.patch(`/api/issues/${story.key}`, { statusId: sid('Client Review'), fields: { [env.id]: 'UAT' } });
    expect(ok.status).toBe(200);
    expect(ok.body.issue.labels).toContain('client-review');
  });

  it('Marketing Cloud build: email QA template with its checklist', async () => {
    const r = await bob.client.post('/api/projects', {
      key: 'MC',
      name: 'Marketing Cloud',
      templateId: 'builtin:marketing-cloud',
      startDate: START,
    });
    expect(r.status).toBe(201);
    expect(r.body.project.statuses.map((s) => s.name)).toEqual(['To Do', 'In Progress', 'QA', 'Client Review', 'Done']);
    const fields = (await bob.client.get('/api/projects/MC/fields')).body.fields;
    expect(fields.map((f) => f.name)).toEqual(['Business Unit', 'Send date']);
    const qa = (await bob.client.get('/api/projects/MC/templates')).body.templates.find((t) => t.name === 'Email QA');
    expect(qa.subtasks).toHaveLength(9);
    const issues = await issuesOf(bob.client, 'MC');
    expect(issues.filter((i) => i.type === 'epic').map((i) => i.title)).toEqual(
      expect.arrayContaining(['Journeys', 'Data Extensions', 'Email templates', 'CloudPages', 'Automations']),
    );
    expect(issues.find((i) => i.title === 'Journeys').dueDate).toBe(at('week 7'));
  });

  it('Support: transitions, required values, SLA field, monthly health check, no sprint', async () => {
    const r = await bob.client.post('/api/projects', { key: 'SUP', name: 'Acme support', templateId: 'builtin:support', startDate: START });
    expect(r.status).toBe(201);
    const p = r.body.project;
    expect(p.statuses.map((s) => s.name)).toEqual(['New', 'Triaged', 'In Progress', 'Waiting on client', 'Resolved']);
    expect(p.permissions.sprints).toBe('admins');
    expect((await bob.client.get('/api/projects/SUP/sprints')).body.sprints).toEqual([]);
    const sid = (n) => p.statuses.find((s) => s.name === n).id;
    const wf = (await bob.client.get('/api/projects/SUP/workflow')).body.workflow;
    expect(wf.transitions[sid('New')].sort()).toEqual([sid('Triaged'), sid('Resolved')].sort());
    const rules = (await bob.client.get('/api/projects/SUP/recurring')).body.rules;
    expect(rules[0]).toMatchObject({ name: 'Monthly health check', schedule: { freq: 'monthly', monthly: 'day', day: 1 }, dueDays: 5 });
    expect(rules[0].subtasks).toHaveLength(5);
    // the Client field is required on new issues
    expect((await bob.client.post('/api/issues', { projectKey: 'SUP', title: 'No client' })).status).toBe(400);
  });

  it('Internal kanban: three columns and one starter task', async () => {
    const r = await bob.client.post('/api/projects', { key: 'INT', name: 'Internal', templateId: 'builtin:kanban', startDate: START });
    expect(r.status).toBe(201);
    expect(r.body.project.statuses.map((s) => [s.name, s.wipLimit])).toEqual([
      ['To Do', null],
      ['Doing', 5],
      ['Done', null],
    ]);
    expect((await bob.client.get('/api/projects/INT/workflow')).body.workflow.transitions).toBe(null);
    const issues = await issuesOf(bob.client, 'INT');
    expect(issues.map((i) => [i.title, i.dueDate])).toEqual([['Write a one-page brief: goal, people, deadline', '2026-12-11']]);
  });

  it('blank still makes the default columns; an unknown template is refused', async () => {
    const r = await bob.client.post('/api/projects', { key: 'BL', name: 'Blank', templateId: 'blank' });
    expect(r.body.project.statuses.map((s) => s.name)).toEqual(['To Do', 'In Progress', 'In Review', 'Done']);
    const bad = await bob.client.post('/api/projects', { key: 'BAD', name: 'Bad', templateId: 'nope' });
    expect(bad.status).toBe(400);
    expect((await ctx.admin.get('/api/projects/BAD')).status).toBe(404);
  });
});

describe('save a project as a template', () => {
  async function source() {
    await bob.client.post('/api/projects', {
      key: 'SRC',
      name: 'Source',
      templateId: 'builtin:salesforce',
      startDate: START,
      leadId: bob.id,
    });
    await bob.client.put(`/api/projects/SRC/members/${carol.id}`, { role: 'member' });
    // finish one story, add an extra one assigned to Carol
    const issues = await issuesOf(bob.client, 'SRC');
    const done = (await bob.client.get('/api/projects/SRC')).body.project.statuses.find((s) => s.name === 'Done').id;
    await bob.client.patch(`/api/issues/${issues.find((i) => i.title === 'Integration design').key}`, { statusId: done });
    await bob.client.post('/api/issues', { projectKey: 'SRC', title: 'Carol owns this', assigneeId: carol.id, labels: ['custom-label'] });
  }

  it('re-creates the structure, keeps the lead as a role and never stores people', async () => {
    await source();
    const r = await bob.client.post('/api/project-templates', {
      projectKey: 'SRC',
      name: 'Our Salesforce way',
      includeIssues: true,
      keepRoles: true,
    });
    expect(r.status).toBe(201);
    expect(r.body.template).toMatchObject({
      name: 'Our Salesforce way',
      visibility: 'private',
      builtin: false,
      canEdit: true,
      owner: { id: bob.id },
    });
    expect(r.body.template.summary.labels).toEqual(expect.arrayContaining(['custom-label']));
    const row = await ctx.db.get('SELECT body FROM project_templates WHERE id = ?', [r.body.template.id]);
    for (const u of await ctx.db.all('SELECT id FROM users')) expect(row.body).not.toContain(u.id);
    const body = JSON.parse(row.body);
    expect(body.issues.find((i) => i.title === 'Integration design')).toBeUndefined(); // done: left out
    expect(body.issues.find((i) => i.title === 'Kick-off meeting and stakeholder list').assignee).toBe('lead');
    expect(body.issues.find((i) => i.title === 'Carol owns this').assignee).toBe(null);

    const n = await carol.client.post('/api/projects', { key: 'NEW', name: 'New', templateId: r.body.template.id, startDate: START });
    expect(n.status).toBe(400); // private to Bob
    const made = await bob.client.post('/api/projects', {
      key: 'NEW',
      name: 'New',
      templateId: r.body.template.id,
      startDate: START,
      leadId: carol.id,
    });
    expect(made.status).toBe(201);
    expect(made.body.project.statuses.map((s) => s.name)).toEqual(['To Do', 'In Progress', 'In Review', 'Client Review', 'Done']);
    expect((await bob.client.get('/api/projects/NEW/fields')).body.fields.map((f) => f.name)).toEqual(['Client', 'Environment', 'Cloud']);
    expect((await bob.client.get('/api/projects/NEW/components')).body.components).toHaveLength(7);
    expect((await bob.client.get('/api/projects/NEW/templates')).body.templates.map((t) => t.name)).toEqual([
      'UAT bug',
      'User story',
      'Change request',
    ]);
    const rules = (await bob.client.get('/api/projects/NEW/recurring')).body.rules;
    expect(rules[0].assignee.id).toBe(carol.id); // lead of the new project
    const issues = await issuesOf(bob.client, 'NEW');
    expect(issues).toHaveLength(24); // 24 starters - 1 done + 1 new
    expect(issues.find((i) => i.title === 'Kick-off meeting and stakeholder list').assignee.id).toBe(carol.id);
    expect(issues.find((i) => i.title === 'Carol owns this')).toMatchObject({ assignee: null, labels: ['custom-label'] });
    expect(issues.find((i) => i.title === 'Build integrations').parent.key).toBe(issues.find((i) => i.title === 'Build').key);
    const wf = (await bob.client.get('/api/projects/NEW/workflow')).body.workflow;
    const fields = (await bob.client.get('/api/projects/NEW/fields')).body.fields;
    const cr = made.body.project.statuses.find((s) => s.name === 'Client Review').id;
    expect(wf.statuses[cr].required).toEqual([`cf:${fields.find((f) => f.name === 'Environment').id}`]);
  });

  it('without starter issues or roles', async () => {
    await source();
    const r = await bob.client.post('/api/project-templates', { projectKey: 'SRC' });
    expect(r.body.template.name).toBe('Source template');
    expect(r.body.template.summary).toMatchObject({ epics: 0, stories: 0, tasks: 0 });
    const body = JSON.parse((await ctx.db.get('SELECT body FROM project_templates WHERE id = ?', [r.body.template.id])).body);
    expect(body.recurring[0].assignee).toBe(null);
  });

  it('private and shared; only the owner or an admin can change or delete it', async () => {
    await source();
    const id = (await bob.client.post('/api/project-templates', { projectKey: 'SRC', name: 'Mine' })).body.template.id;
    const ids = async (c) => (await c.get('/api/project-templates')).body.templates.map((t) => t.id);
    expect(await ids(carol.client)).not.toContain(id);
    expect((await carol.client.patch(`/api/project-templates/${id}`, { visibility: 'shared' })).status).toBe(404);
    expect(
      (await bob.client.patch(`/api/project-templates/${id}`, { visibility: 'shared', description: 'Our way' })).body.template,
    ).toMatchObject({ visibility: 'shared', description: 'Our way' });
    expect(await ids(carol.client)).toContain(id);
    expect((await carol.client.post('/api/projects', { key: 'CAR', name: 'Carol', templateId: id, startDate: START })).status).toBe(201);
    expect((await carol.client.del(`/api/project-templates/${id}`)).status).toBe(403);
    expect((await carol.client.del('/api/project-templates/builtin:salesforce')).status).toBe(400);
    const all = (await ctx.admin.get('/api/project-templates?all=1')).body.templates;
    expect(all.map((t) => t.id)).toEqual([id]); // saved ones only
    expect((await ctx.admin.del(`/api/project-templates/${id}`)).status).toBe(200);
    expect(await ids(bob.client)).not.toContain(id);
  });

  it('only project admins can save one', async () => {
    await source();
    expect((await carol.client.post('/api/project-templates', { projectKey: 'SRC' })).status).toBe(403);
  });
});

describe('access', () => {
  it('guests cannot list, save or apply templates', async () => {
    const gina = await addUser(ctx, { email: 'gina@client.example', name: 'Gina', role: 'guest' });
    expect((await gina.client.get('/api/project-templates')).status).toBe(403);
    expect((await gina.client.post('/api/projects', { key: 'GG', name: 'G', templateId: 'builtin:kanban' })).status).toBe(403);
    expect((await gina.client.post('/api/project-templates', { projectKey: 'X' })).status).toBe(403);
  });

  it('respects projectCreation = admins', async () => {
    await ctx.admin.patch('/api/admin/settings', { projectCreation: 'admins' });
    expect((await bob.client.post('/api/projects', { key: 'NO', name: 'No', templateId: 'builtin:kanban' })).status).toBe(403);
    expect((await ctx.admin.post('/api/projects', { key: 'YES', name: 'Yes', templateId: 'builtin:kanban' })).status).toBe(201);
  });
});

describe('statement budget', () => {
  it('applies the largest built-in and a saved template in well under 50 statements', async () => {
    const meter = countingDb(ctx.env.db);
    ctx.env.db = meter.counted;
    const results = {};
    for (const t of BUILTINS) {
      meter.reset();
      const r = await bob.client.post('/api/projects', {
        key: `B${BUILTINS.indexOf(t)}`,
        name: t.name,
        templateId: t.id,
        startDate: START,
      });
      expect(r.status, t.name).toBe(201);
      results[t.id] = meter.count;
    }
    meter.reset();
    const saved = await bob.client.post('/api/project-templates', { projectKey: 'B0', includeIssues: true, keepRoles: true });
    expect(saved.status).toBe(201);
    results.save = meter.count;
    meter.reset();
    expect(
      (
        await bob.client.post('/api/projects', {
          key: 'FROMSAVED',
          name: 'From saved',
          templateId: saved.body.template.id,
          startDate: START,
        })
      ).status,
    ).toBe(201);
    results.applySaved = meter.count;
    console.log('statements per template request:', JSON.stringify(results));
    for (const [name, n] of Object.entries(results)) expect(n, `${name} used ${n}`).toBeLessThan(45);
  });

  it('keeps a full saved template (150 starter issues) within budget and bound-value limits', async () => {
    const body = readBody({
      statuses: [
        { name: 'To Do', category: 'todo' },
        { name: 'Done', category: 'done' },
      ],
      issues: Array.from({ length: 150 }, (_, i) => ({
        ref: `r${i}`,
        type: i < 10 ? 'epic' : 'story',
        parent: i < 10 ? null : `r${i % 10}`,
        title: `Issue ${i} with 'quotes'`,
        labels: ['a', 'b'],
        due: `day ${i + 1}`,
      })),
    });
    await ctx.db.run(
      `INSERT INTO project_templates (id, name, owner_id, visibility, body, created_at, updated_at) VALUES ('big', 'Big', ?, 'private', ?, 'x', 'x')`,
      [bob.id, JSON.stringify(body)],
    );
    const params = [];
    const meter = countingDb(ctx.env.db);
    const batch = meter.counted.batch;
    meter.counted.batch = async (s) => {
      for (const x of s) params.push(x.params.length);
      return batch(s);
    };
    ctx.env.db = meter.counted;
    const r = await bob.client.post('/api/projects', { key: 'BIG', name: 'Big', templateId: 'big', startDate: START });
    expect(r.status).toBe(201);
    expect(meter.count).toBeLessThan(45);
    expect(Math.max(...params)).toBeLessThanOrEqual(100);
    const issues = await issuesOf(bob.client, 'BIG');
    expect(issues).toHaveLength(150);
    expect(issues.find((i) => i.title === "Issue 149 with 'quotes'").dueDate).toBe(at('day 150'));
  });
});

describe('backups', () => {
  it('include saved templates in a full backup, not in a project export', async () => {
    await bob.client.post('/api/projects', { key: 'SRC', name: 'Source', templateId: 'builtin:kanban', startDate: START });
    await bob.client.post('/api/project-templates', { projectKey: 'SRC', name: 'Kept' });
    const full = await ctx.admin.get('/api/admin/backup');
    const b = typeof full.body === 'string' ? JSON.parse(full.body) : full.body;
    expect(b.schema).toBe(BACKUP_SCHEMA);
    expect(b.tables.project_templates).toEqual([expect.objectContaining({ name: 'Kept', owner_id: bob.id, visibility: 'private' })]);
    const one = await bob.client.get('/api/projects/SRC/export.json');
    const p = typeof one.body === 'string' ? JSON.parse(one.body) : one.body;
    expect(p.tables.project_templates).toBeUndefined();
  });
});
