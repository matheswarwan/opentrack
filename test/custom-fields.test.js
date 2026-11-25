import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser, client } from './helpers.js';

let ctx, bob, carol, dave;
const base = '/api/projects/WEB/fields';

beforeEach(async () => {
  ctx = await withAdmin({ PUBLIC_URL: 'https://tracker.example.com' });
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' }); // creates WEB: project admin (lead)
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' }); // a plain member
  dave = await addUser(ctx, { email: 'dave@example.com', name: 'Dave' });
  expect((await bob.client.post('/api/projects', { key: 'web', name: 'Website' })).status).toBe(201);
});

async function field(def) {
  const r = await bob.client.post(base, def);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.field;
}
async function issue(data = {}) {
  const r = await bob.client.post('/api/issues', { projectKey: 'WEB', title: 'Issue', ...data });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.issue;
}
const search = async (who, q) =>
  (await who.client.get(`/api/issues?project=WEB&${new URLSearchParams(q)}`)).body.issues.map((i) => i.key).sort();

async function setup() {
  const sev = await field({ name: 'Severity', type: 'select', options: ['Low', 'High', 'Critical'] });
  const areas = await field({ name: 'Areas', type: 'multiselect', options: ['UI', 'API', 'Docs'] });
  const cust = await field({ name: 'Customer', type: 'text' });
  const notes = await field({ name: 'Notes', type: 'longtext' });
  const cost = await field({ name: 'Cost', type: 'number' });
  const ship = await field({ name: 'Ship date', type: 'date' });
  const sec = await field({ name: 'Security', type: 'checkbox' });
  const owner = await field({ name: 'Owner', type: 'user' });
  const spec = await field({ name: 'Spec', type: 'url' });
  return { sev, areas, cust, notes, cost, ship, sec, owner, spec };
}

describe('field definitions', () => {
  it('only project admins create and change fields; members can read them', async () => {
    expect((await carol.client.post(base, { name: 'X', type: 'text' })).status).toBe(403);
    const f = await field({
      name: 'Severity',
      type: 'select',
      options: ['Low', 'High'],
      help: 'How bad it is',
      required: true,
      issueTypes: ['bug'],
    });
    expect(f).toMatchObject({
      name: 'Severity',
      type: 'select',
      required: true,
      help: 'How bad it is',
      issueTypes: ['bug'],
      archived: false,
    });
    expect(f.options.map((o) => o.name)).toEqual(['Low', 'High']);
    expect((await carol.client.get(base)).body.fields).toHaveLength(1);
    expect((await carol.client.patch(`${base}/${f.id}`, { name: 'Y' })).status).toBe(403);
    expect((await carol.client.del(`${base}/${f.id}`)).status).toBe(403);
    expect((await bob.client.post(base, { name: 'severity', type: 'text' })).status).toBe(409);
    expect((await bob.client.post(base, { name: 'Bad', type: 'colour' })).status).toBe(400);
    expect((await bob.client.post(base, { name: 'No options', type: 'select', options: [] })).status).toBe(400);
    expect((await bob.client.patch(`${base}/${f.id}`, { type: 'text' })).status).toBe(400);
    // the project payload lists the fields too
    expect((await carol.client.get('/api/projects/WEB')).body.project.fields[0].name).toBe('Severity');
    // a workspace admin can manage any project's fields
    expect((await ctx.admin.patch(`/api/projects/WEB/fields/${f.id}`, { help: 'Set by triage' })).body.field.help).toBe('Set by triage');
    expect((await bob.client.del(`${base}/${f.id}`)).status).toBe(200);
    expect((await bob.client.get(base)).body.fields).toHaveLength(0);
  });

  it('options can be added, renamed, reordered and archived; renamed and archived options keep values', async () => {
    const f = await field({ name: 'Severity', type: 'select', options: ['Low', 'High'] });
    const [low, high] = f.options;
    const i = await issue({ fields: { [f.id]: 'High' } }); // by name
    expect(i.fields[f.id]).toEqual({ id: high.id, name: 'High' });
    const r = await bob.client.patch(`${base}/${f.id}`, {
      options: [{ id: high.id, name: 'Major' }, { id: low.id, name: 'Low', archived: true }, { name: 'Blocker' }],
    });
    expect(r.status).toBe(200);
    expect(r.body.field.options.map((o) => [o.name, o.archived])).toEqual([
      ['Major', false],
      ['Low', true],
      ['Blocker', false],
    ]);
    expect((await bob.client.get(`/api/issues/${i.key}`)).body.issue.fields[f.id]).toEqual({ id: high.id, name: 'Major' });
    // an option left out of the list is kept, archived
    const r2 = await bob.client.patch(`${base}/${f.id}`, {
      options: [
        { id: high.id, name: 'Major' },
        { name: 'Blocker', id: r.body.field.options[2].id },
      ],
    });
    expect(r2.body.field.options.find((o) => o.id === low.id)).toMatchObject({ name: 'Low', archived: true });
    // archived options cannot be picked for new values, but a value already set keeps working
    const j = await issue();
    expect((await bob.client.patch(`/api/issues/${j.key}`, { fields: { [f.id]: low.id } })).status).toBe(400);
    await ctx.db.run('INSERT INTO issue_field_values (issue_id, field_id, value) VALUES (?, ?, ?)', [j.id, f.id, low.id]);
    const shown = (await bob.client.get(`/api/issues/${j.key}`)).body.issue.fields[f.id];
    expect(shown).toEqual({ id: low.id, name: 'Low', archived: true });
    expect((await bob.client.patch(`/api/issues/${j.key}`, { fields: { [f.id]: low.id }, title: 'Same option' })).status).toBe(200);
  });

  it('archived fields are hidden from payloads and refuse new values, but keep them', async () => {
    const f = await field({ name: 'Customer', type: 'text' });
    const i = await issue({ fields: { Customer: 'Acme' } });
    await bob.client.patch(`${base}/${f.id}`, { archived: true });
    const d = (await bob.client.get(`/api/issues/${i.key}`)).body.issue;
    expect(d.fields[f.id]).toBeUndefined();
    expect((await bob.client.patch(`/api/issues/${i.key}`, { fields: { [f.id]: 'Other' } })).status).toBe(400);
    await bob.client.patch(`${base}/${f.id}`, { archived: false });
    expect((await bob.client.get(`/api/issues/${i.key}`)).body.issue.fields[f.id]).toBe('Acme');
  });
});

describe('values', () => {
  it('validates and normalizes each type', async () => {
    const f = await setup();
    const bad = async (id, value) =>
      (await bob.client.post('/api/issues', { projectKey: 'WEB', title: 'x', fields: { [id]: value } })).status;
    expect(await bad(f.sev.id, 'Unknown')).toBe(400);
    expect(await bad(f.areas.id, ['UI', 'Nope'])).toBe(400);
    expect(await bad(f.areas.id, 'UI')).toBe(201); // one option as text is fine
    expect(await bad(f.cust.id, 'x'.repeat(501))).toBe(400);
    expect(await bad(f.cost.id, 'abc')).toBe(400);
    expect(await bad(f.ship.id, '2026-02-30')).toBe(400);
    expect(await bad(f.ship.id, '12/01/2026')).toBe(400);
    expect(await bad(f.sec.id, 'maybe')).toBe(400);
    expect(await bad(f.owner.id, 'nobody@example.com')).toBe(400);
    expect(await bad(f.spec.id, 'javascript:alert(1)')).toBe(400);
    expect(await bad('no-such-field', 'x')).toBe(400);

    const i = await issue({
      fields: {
        Severity: 'critical',
        Areas: ['Docs', 'UI', 'UI'],
        Customer: '  Acme Corp  ',
        Notes: 'Line 1\nLine 2',
        Cost: '12.50',
        'Ship date': '2026-12-01',
        Security: 'yes',
        Owner: 'carol@example.com',
        Spec: 'https://example.com/spec',
      },
    });
    expect(i.fields[f.sev.id].name).toBe('Critical');
    expect(i.fields[f.areas.id].map((o) => o.name)).toEqual(['UI', 'Docs']); // option order, no duplicates
    expect(i.fields[f.cust.id]).toBe('Acme Corp');
    expect(i.fields[f.notes.id]).toBe('Line 1\nLine 2');
    expect(i.fields[f.cost.id]).toBe(12.5);
    expect(i.fields[f.ship.id]).toBe('2026-12-01');
    expect(i.fields[f.sec.id]).toBe(true);
    expect(i.fields[f.owner.id]).toMatchObject({ id: carol.id, name: 'Carol' });
    expect(i.fields[f.spec.id]).toBe('https://example.com/spec');
    const stored = Object.fromEntries(
      (await ctx.db.all('SELECT field_id, value FROM issue_field_values WHERE issue_id = ?', [i.id])).map((r) => [r.field_id, r.value]),
    );
    expect(stored[f.cost.id]).toBe('12.5');
    expect(stored[f.sec.id]).toBe('1');
    expect(JSON.parse(stored[f.areas.id])).toHaveLength(2);
    expect(stored[f.owner.id]).toBe(carol.id);
    // clearing removes the row
    await bob.client.patch(`/api/issues/${i.key}`, { fields: { [f.cust.id]: '', [f.cost.id]: null } });
    const after = (await bob.client.get(`/api/issues/${i.key}`)).body.issue.fields;
    expect(after[f.cust.id]).toBeUndefined();
    expect(after[f.cost.id]).toBeUndefined();
  });

  it('required fields are enforced on create for the types they apply to, not forced on existing issues', async () => {
    const old = await issue({ type: 'bug' });
    const f = await field({ name: 'Severity', type: 'select', options: ['Low', 'High'], required: true, issueTypes: ['bug'] });
    const r = await bob.client.post('/api/issues', { projectKey: 'WEB', type: 'bug', title: 'No severity' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Severity is required/);
    expect((await bob.client.post('/api/issues', { projectKey: 'WEB', type: 'task', title: 'A task' })).status).toBe(201);
    expect(
      (await bob.client.post('/api/issues', { projectKey: 'WEB', type: 'task', title: 'A task', fields: { Severity: 'Low' } })).status,
    ).toBe(400); // bugs only
    expect((await bob.client.patch(`/api/issues/${old.key}`, { title: 'Still fine' })).status).toBe(200);
    await bob.client.patch(`/api/issues/${old.key}`, { fields: { [f.id]: 'Low' } });
    expect((await bob.client.patch(`/api/issues/${old.key}`, { fields: { [f.id]: null } })).status).toBe(400); // cannot clear
  });

  it('writes history with display values', async () => {
    const f = await setup();
    const i = await issue();
    await bob.client.patch(`/api/issues/${i.key}`, { fields: { [f.sev.id]: 'High', [f.owner.id]: carol.id, [f.sec.id]: true } });
    await bob.client.patch(`/api/issues/${i.key}`, { fields: { [f.sev.id]: 'Critical', [f.sec.id]: true } }); // Security unchanged
    const h = (await bob.client.get(`/api/issues/${i.key}`)).body.issue.history.filter((x) => x.field.startsWith('field:'));
    expect(h.map((x) => [x.field, x.from, x.to])).toEqual([
      ['field:Severity', null, 'High'],
      ['field:Owner', null, 'Carol'],
      ['field:Security', null, 'Yes'],
      ['field:Severity', 'High', 'Critical'],
    ]);
  });
});

describe('search', () => {
  it('filters per type, and by empty', async () => {
    const f = await setup();
    const high = f.sev.options.find((o) => o.name === 'High').id;
    const api = f.areas.options.find((o) => o.name === 'API').id;
    const a = await issue({
      fields: {
        Severity: 'High',
        Areas: ['UI', 'API'],
        Customer: 'Acme Corp',
        Cost: 10,
        'Ship date': '2026-12-01',
        Security: true,
        Owner: carol.id,
        Spec: 'https://a.example',
      },
    });
    const b = await issue({ fields: { Severity: 'Low', Areas: ['Docs'], Customer: 'Globex 50%', Cost: '10.5', Security: false } });
    const c = await issue();
    expect(await search(bob, { [`cf.${f.sev.id}`]: high })).toEqual([a.key]);
    expect(await search(bob, { [`cf.${f.areas.id}`]: api })).toEqual([a.key]);
    expect(await search(bob, { [`cf.${f.cust.id}`]: 'acme' })).toEqual([a.key]);
    expect(await search(bob, { [`cf.${f.cust.id}`]: '50%' })).toEqual([b.key]); // LIKE characters are escaped
    expect(await search(bob, { [`cf.${f.cust.id}`]: '%' })).toEqual([b.key]);
    expect(await search(bob, { [`cf.${f.cost.id}`]: '10.0' })).toEqual([a.key]);
    expect(await search(bob, { [`cf.${f.cost.id}`]: '10.50' })).toEqual([b.key]);
    expect(await search(bob, { [`cf.${f.ship.id}`]: '2026-12-01' })).toEqual([a.key]);
    expect(await search(bob, { [`cf.${f.sec.id}`]: 'true' })).toEqual([a.key]);
    expect(await search(bob, { [`cf.${f.sec.id}`]: '0' })).toEqual([b.key]);
    expect(await search(bob, { [`cf.${f.owner.id}`]: carol.id })).toEqual([a.key]);
    expect(await search(bob, { [`cf.${f.sev.id}.empty`]: '1' })).toEqual([c.key]);
    expect(await search(bob, { [`cf.${f.ship.id}.empty`]: '0' })).toEqual([a.key]);
    expect(await search(bob, { [`cf.${f.ship.id}.empty`]: '1' })).toEqual([b.key, c.key].sort());
  });

  it('list payloads include fields only with withFields=1', async () => {
    const f = await setup();
    await issue({ fields: { Severity: 'High' } });
    const plain = (await bob.client.get('/api/issues?project=WEB')).body.issues[0];
    expect(plain.fields).toBeUndefined();
    const withF = (await bob.client.get('/api/issues?project=WEB&withFields=1')).body.issues[0];
    expect(withF.fields[f.sev.id].name).toBe('High');
  });

  it('keeps private project fields away from non-members', async () => {
    const f = await field({ name: 'Secret', type: 'select', options: ['Yes', 'No'] });
    const yes = f.options[0].id;
    await issue({ fields: { Secret: 'Yes' } });
    await bob.client.patch('/api/projects/WEB', { visibility: 'private' });
    expect((await dave.client.get(base)).status).toBe(404);
    expect((await dave.client.get(`/api/issues?cf.${f.id}=${yes}&withFields=1`)).body.issues).toEqual([]);
    const rep = await dave.client.post('/api/report-data', {
      source: { query: {} },
      kind: 'breakdown',
      options: { groupBy: `cf:${f.id}` },
    });
    expect(rep.status).toBe(400);
    expect((await dave.client.post('/api/feeds', { name: 'x', query: {}, columns: ['key', `cf:${f.id}`] })).status).toBe(400);
    expect((await dave.client.get('/api/feeds?project=WEB')).status).toBe(404);
  });
});

describe('everywhere else', () => {
  it('bulk edit sets a field on many issues, with history', async () => {
    const f = await setup();
    const a = await issue();
    const b = await issue();
    const r = await bob.client.post('/api/issues/bulk', { keys: [a.key, b.key], changes: { fields: { [f.sev.id]: 'Critical' } } });
    expect(r.body.updated).toBe(2);
    expect(r.body.results[0].changed).toEqual(['field:Severity']);
    const crit = f.sev.options.find((o) => o.name === 'Critical').id;
    expect(await search(bob, { [`cf.${f.sev.id}`]: crit })).toEqual([a.key, b.key].sort());
  });

  it('CSV export has a column per field', async () => {
    const f = await setup();
    await issue({ title: 'Exported', fields: { Severity: 'High', Areas: ['UI', 'Docs'], Security: true, Owner: carol.id } });
    const csv = (await bob.client.get('/api/issues.csv?project=WEB')).body;
    const [head, row] = csv.split('\n');
    expect(head).toContain('Severity,Areas,Customer,Notes,Cost,Ship date,Security,Owner,Spec');
    expect(row).toContain('High,"UI, Docs",,,,,Yes,Carol,');
    expect(f.sev.id).toBeTruthy();
  });

  it('Google Sheets feeds can show field columns', async () => {
    const f = await setup();
    await issue({ title: 'Fed', fields: { Severity: 'High', Cost: 3 } });
    const cols = (await carol.client.get('/api/feeds?project=WEB')).body.columns.map((c) => c.id);
    expect(cols).toContain(`cf:${f.sev.id}`);
    const r = await carol.client.post('/api/feeds', {
      name: 'Plan',
      query: { project: 'WEB', [`cf.${f.sev.id}.empty`]: '0' },
      columns: ['key', `cf:${f.sev.id}`, `cf:${f.cost.id}`],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.feed.query[`cf.${f.sev.id}.empty`]).toBe('0');
    const lines = (await client(ctx).get(new URL(r.body.url).pathname)).body.trim().split('\n');
    expect(lines).toEqual(['Key,Severity,Cost', 'WEB-1,High,3']);
    expect((await carol.client.post('/api/feeds', { name: 'Bad', columns: ['key', 'cf:nope'] })).status).toBe(400);
  });

  it('import maps columns to fields (names, yes/no, lists, people) and enforces required fields', async () => {
    const f = await setup();
    await bob.client.patch(`${base}/${f.cust.id}`, { required: true });
    const rows = [
      {
        title: 'One',
        fields: {
          Severity: 'high',
          Areas: 'UI, API',
          Security: 'yes',
          Owner: 'Carol',
          Cost: '7',
          Customer: 'Acme',
          'Ship date': '2026-01-05',
        },
      },
      { title: 'Two', fields: { [f.cust.id]: 'Globex', [f.sec.id]: 'no' } },
    ];
    const dry = await bob.client.post('/api/projects/WEB/import', { rows, dryRun: true });
    expect(dry.body.valid, JSON.stringify(dry.body)).toBe(true);
    const missing = await bob.client.post('/api/projects/WEB/import', { rows: [{ title: 'No customer' }], dryRun: true });
    expect(missing.body.rows[0].errors).toEqual(['Customer is required']);
    const badRow = await bob.client.post('/api/projects/WEB/import', {
      rows: [{ title: 'x', fields: { Customer: 'A', Severity: 'Nope' } }],
      dryRun: true,
    });
    expect(badRow.body.rows[0].errors[0]).toMatch(/Severity: no option/);
    const r = await bob.client.post('/api/projects/WEB/import', { rows });
    expect(r.status).toBe(201);
    const one = (await bob.client.get(`/api/issues/${r.body.created[0].key}`)).body.issue.fields;
    expect(one[f.sev.id].name).toBe('High');
    expect(one[f.areas.id].map((o) => o.name)).toEqual(['UI', 'API']);
    expect(one[f.sec.id]).toBe(true);
    expect(one[f.owner.id].name).toBe('Carol');
    expect(one[f.cost.id]).toBe(7);
    const two = (await bob.client.get(`/api/issues/${r.body.created[1].key}`)).body.issue.fields;
    expect(two[f.sec.id]).toBe(false);
  });

  it('templates hold default field values', async () => {
    const f = await setup();
    const r = await bob.client.post('/api/projects/WEB/templates', {
      name: 'Bug report',
      type: 'bug',
      fields: { Severity: 'High', Areas: ['Docs'], Security: true },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const high = f.sev.options.find((o) => o.name === 'High').id;
    expect(r.body.template.fields).toEqual({ [f.sev.id]: high, [f.areas.id]: [f.areas.options[2].id], [f.sec.id]: true });
    expect((await bob.client.post('/api/projects/WEB/templates', { name: 'Bad', fields: { Severity: 'Nope' } })).status).toBe(400);
    const p = await bob.client.patch(`/api/projects/WEB/templates/${r.body.template.id}`, { fields: { Severity: 'Low' } });
    expect(Object.keys(p.body.template.fields)).toEqual([f.sev.id]);
    // the defaults work as issue values
    expect(
      (await bob.client.post('/api/issues', { projectKey: 'WEB', title: 'From template', fields: r.body.template.fields })).status,
    ).toBe(201);
  });

  it('custom reports group by a select, multi-select, user or checkbox field, with filters that match', async () => {
    const f = await setup();
    await issue({ fields: { Severity: 'High', Areas: ['UI', 'API'], Owner: carol.id } });
    await issue({ fields: { Severity: 'High', Areas: ['UI'] } });
    await issue({ fields: { Severity: 'Low' } });
    await issue();
    const r = await bob.client.post('/api/report-data', {
      source: { query: { project: 'WEB' } },
      kind: 'breakdown',
      options: { groupBy: `cf:${f.sev.id}` },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.groupLabel).toBe('Severity');
    expect(r.body.groups.map((g) => [g.label, g.count])).toEqual([
      ['High', 2],
      ['Low', 1],
      ['No value', 1],
    ]);
    // a segment's filter finds the same issues
    const g = r.body.groups[0];
    expect((await bob.client.get(`/api/issues?project=WEB&${new URLSearchParams(g.filter)}`)).body.total).toBe(2);
    const none = r.body.groups.find((x) => x.key === 'none');
    expect((await bob.client.get(`/api/issues?project=WEB&${new URLSearchParams(none.filter)}`)).body.total).toBe(1);
    // multi-select: one group per option; the issue count stays the number of issues
    const m = await bob.client.post('/api/report-data', {
      source: { query: { project: 'WEB' } },
      kind: 'breakdown',
      options: { groupBy: `cf:${f.areas.id}` },
    });
    expect(Object.fromEntries(m.body.groups.map((x) => [x.label, x.count]))).toEqual({ UI: 2, API: 1, 'No value': 2 });
    expect(m.body.issues).toBe(4);
    // two-dimensional: severity by owner
    const t = await bob.client.post('/api/report-data', {
      source: { query: { project: 'WEB' } },
      kind: 'twoD',
      options: { rows: `cf:${f.sev.id}`, columns: `cf:${f.owner.id}` },
    });
    expect(t.status).toBe(200);
    expect(t.body.columns.map((c) => c.label).sort()).toEqual(['Carol', 'No value']);
    // text fields cannot be group-by fields
    expect(
      (await bob.client.post('/api/report-data', { source: { query: {} }, kind: 'breakdown', options: { groupBy: `cf:${f.cust.id}` } }))
        .status,
    ).toBe(400);
    // a saved report keeps the field
    const saved = await bob.client.post('/api/saved-reports', {
      name: 'By severity',
      kind: 'breakdown',
      source: { query: { project: 'WEB', [`cf.${f.sec.id}.empty`]: '1' } },
      options: { groupBy: `cf:${f.sev.id}` },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect(saved.body.report.source.query[`cf.${f.sec.id}.empty`]).toBe('1');
    expect((await bob.client.post('/api/report-data', { reportId: saved.body.report.id })).body.issues).toBe(4);
  });

  it('MCP tools read and write fields by name', async () => {
    const f = await setup();
    const token = (await bob.client.post('/api/me/tokens', { name: 'AI' })).body.token;
    let n = 0;
    const tool = async (name, args) => {
      const res = await ctx.app.request(
        'http://t.example/mcp',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }),
        },
        ctx.env,
      );
      const r = (await res.json()).result;
      return { error: r.isError ? r.content[0].text : null, data: r.isError ? null : JSON.parse(r.content[0].text) };
    };
    const c = await tool('create_issue', {
      project: 'WEB',
      title: 'Via MCP',
      fields: { severity: 'High', Areas: ['UI'], Owner: 'me', Security: true },
    });
    expect(c.error).toBeNull();
    const g = await tool('get_issue', { key: c.data.created });
    expect(g.data.fields).toEqual({ Severity: 'High', Areas: ['UI'], Security: true, Owner: 'Bob' });
    const u = await tool('update_issue', { key: c.data.created, fields: { Severity: 'Low', Owner: 'carol@example.com' } });
    expect(u.error).toBeNull();
    expect(u.data.changed).toEqual(['field:Severity', 'field:Owner']);
    const bad = await tool('update_issue', { key: c.data.created, fields: { Colour: 'red' } });
    expect(bad.error).toMatch(/No field "Colour"/);
    const p = await tool('list_projects', {});
    expect(p.data[0].fields[0]).toBe('Severity (select: Low, High, Critical)');
    // template field defaults
    await bob.client.post('/api/projects/WEB/templates', {
      name: 'Sec bug',
      type: 'bug',
      fields: { Security: true, Severity: 'Critical' },
    });
    const t = await tool('create_issue', { project: 'WEB', title: 'Leak', template: 'Sec bug', fields: { Severity: 'High' } });
    expect((await tool('get_issue', { key: t.data.created })).data.fields).toMatchObject({ Severity: 'High', Security: true });
    expect(f.sev.id).toBeTruthy();
  });

  it('backups include field definitions and values', async () => {
    const f = await setup();
    await issue({ fields: { Severity: 'High' } });
    const b = (await ctx.admin.get('/api/admin/backup')).body;
    expect(b.tables.custom_fields.map((x) => x.name)).toContain('Severity');
    expect(b.tables.issue_field_values).toEqual([expect.objectContaining({ field_id: f.sev.id })]);
    const p = (await bob.client.get('/api/projects/WEB/export.json')).body;
    expect(p.tables.issue_field_values).toHaveLength(1);
  });
});
