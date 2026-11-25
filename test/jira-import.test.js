import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser } from './helpers.js';
import { adfToMarkdown } from '../server/lib/adf.js';
import { cleanSite, suggestKey, mapPriority } from '../server/lib/jira/map.js';

const SITE = 'https://acme.atlassian.net';
const TOKEN = 'secret-jira-token-123';
const MB = 1024 * 1024;

// ---- fixtures ----

const doc = (...content) => ({ type: 'doc', version: 1, content });
const p = (...content) => ({ type: 'paragraph', content });
const tx = (text, marks) => ({ type: 'text', text, ...(marks ? { marks } : {}) });

const person = (accountId, displayName, emailAddress) => ({ accountId, displayName, ...(emailAddress ? { emailAddress } : {}) });
const BOB = person('acc-bob', 'Bob Jira', 'bob@example.com');
const CAROL = person('acc-carol', 'Carol'); // email hidden: matched by name
const ZED = person('acc-zed', 'Zed Outside', 'zed@outside.example');
const GHOST = person('acc-ghost', 'Ghost'); // no email, no match
const OUTSIDER = person('acc-out', 'Outsider');

const sprint = (id, state, name, extra = {}) => ({ id, state, name, boardId: 1, ...extra });

function issue(id, key, fields) {
  return {
    id: String(id),
    key,
    fields: {
      summary: `${key} summary`,
      issuetype: { name: 'Task', subtask: false },
      status: { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
      priority: { name: 'Medium' },
      labels: [],
      created: '2024-01-01T09:00:00.000+0000',
      updated: '2024-01-02T09:00:00.000+0000',
      issuelinks: [],
      attachment: [],
      ...fields,
    },
  };
}

const WEB_ISSUES = [
  issue(101, 'WEB-1', {
    summary: 'Epic one',
    issuetype: { name: 'Epic', subtask: false, hierarchyLevel: 1 },
    description: doc(
      { type: 'heading', attrs: { level: 2 }, content: [tx('Goal')] },
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [p(tx('first'))] },
          { type: 'listItem', content: [p(tx('second', [{ type: 'strong' }]))] },
        ],
      },
    ),
    reporter: BOB,
  }),
  issue(102, 'WEB-2', {
    summary: 'Story two',
    issuetype: { name: 'Story', subtask: false },
    status: { id: '2', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
    priority: { name: 'Blocker' },
    assignee: BOB,
    reporter: CAROL,
    labels: ['ui', 'needs review'],
    duedate: '2024-03-01',
    timeoriginalestimate: 7200,
    customfield_10016: 5,
    customfield_10020: [sprint(11, 'closed', 'Sprint 1'), sprint(12, 'active', 'Sprint 2')],
    parent: { id: '101', key: 'WEB-1' },
    created: '2024-01-05T10:00:00.000+0000',
    description: doc(
      p(
        tx('Hi '),
        { type: 'mention', attrs: { id: 'acc-bob', text: '@Bob Jira' } },
        tx(', see '),
        tx('docs', [{ type: 'link', attrs: { href: 'https://example.com' } }]),
      ),
      {
        type: 'taskList',
        content: [
          { type: 'taskItem', attrs: { state: 'TODO' }, content: [tx('write tests')] },
          { type: 'taskItem', attrs: { state: 'DONE' }, content: [tx('plan')] },
        ],
      },
      { type: 'codeBlock', attrs: { language: 'js' }, content: [tx('const a = 1;')] },
      { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'm1', alt: 'screen.png' } }] },
    ),
    issuelinks: [
      { id: 'L1', type: { name: 'Blocks' }, outwardIssue: { id: '105', key: 'WEB-5' } },
      { id: 'L2', type: { name: 'Relates' }, inwardIssue: { id: '201', key: 'OPS-7' } },
    ],
    attachment: [
      { id: 'A1', filename: 'notes.txt', size: 5, mimeType: 'text/plain', author: BOB, created: '2024-01-05T11:00:00.000+0000' },
      { id: 'A2', filename: 'big.zip', size: 11 * MB, mimeType: 'application/zip', author: BOB },
    ],
  }),
  // WEB-3 was deleted in Jira: the numbers keep the gap
  issue(104, 'WEB-4', {
    summary: 'Sub-task four',
    issuetype: { name: 'Sub-task', subtask: true },
    parent: { id: '105', key: 'WEB-5' },
    reporter: BOB,
  }),
  issue(105, 'WEB-5', {
    summary: 'Task five',
    status: { id: '3', name: 'Done', statusCategory: { key: 'done' } },
    resolutiondate: '2024-02-10T12:00:00.000+0000',
    assignee: ZED,
    reporter: GHOST,
    parent: { id: '101', key: 'WEB-1' },
    issuelinks: [{ id: 'L1', type: { name: 'Blocks' }, inwardIssue: { id: '102', key: 'WEB-2' } }],
  }),
  issue(106, 'WEB-6', {
    summary: 'Bug six',
    issuetype: { name: 'Bug', subtask: false },
    status: { id: '4', name: 'QA', statusCategory: { key: 'indeterminate' } },
    priority: { name: 'Trivial' },
    customfield_10020: [sprint(11, 'closed', 'Sprint 1')],
  }),
];

const OPS_ISSUES = [
  issue(201, 'OPS-7', {
    summary: 'Ops seven',
    issuelinks: [{ id: 'L2', type: { name: 'Relates' }, outwardIssue: { id: '102', key: 'WEB-2' } }],
  }),
];

const COMMENTS = {
  'WEB-2': [
    {
      id: 'c1',
      author: BOB,
      body: doc(p(tx('Looks good'))),
      created: '2024-02-01T10:00:00.000+0000',
      updated: '2024-02-01T10:00:00.000+0000',
    },
    {
      id: 'c2',
      author: OUTSIDER,
      body: doc(p(tx('From outside'))),
      created: '2024-02-02T10:00:00.000+0000',
      updated: '2024-02-02T11:00:00.000+0000',
    },
  ],
};
const WORKLOGS = {
  'WEB-5': [
    {
      id: 'w1',
      author: BOB,
      timeSpentSeconds: 3600,
      started: '2024-02-03T09:00:00.000+0000',
      created: '2024-02-03T10:00:00.000+0000',
      comment: doc(p(tx('Fixing'))),
    },
  ],
};

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A fake Jira Cloud site. `calls` lists every request; `rateLimitOnce` answers the next search with 429. */
function fakeJira() {
  const jira = { calls: [], rateLimitOnce: false };
  const auth = `Basic ${btoa(`admin@acme.example:${TOKEN}`)}`;
  jira.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    jira.calls.push(`${method} ${u.pathname}${u.search}`);
    if (u.origin !== SITE) return json({ errorMessages: ['wrong host'] }, 404);
    if (init.headers?.authorization !== auth) return json({ errorMessages: ['Unauthorized'] }, 401);
    const path = u.pathname;
    const q = u.searchParams;
    if (path === '/rest/api/3/myself') return json({ accountId: 'acc-admin', displayName: 'Ada in Jira' });
    if (path === '/rest/api/3/project/search') {
      return Number(q.get('startAt')) === 0
        ? json({ values: [{ id: '10000', key: 'WEB', name: 'Website' }], isLast: false })
        : json({ values: [{ id: '10001', key: 'OPS', name: 'Operations' }], isLast: true });
    }
    if (path === '/rest/api/3/field') {
      return json([
        { id: 'summary', name: 'Summary' },
        { id: 'customfield_10016', name: 'Story point estimate' },
        { id: 'customfield_10020', name: 'Sprint', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
      ]);
    }
    let m;
    if ((m = /^\/rest\/api\/3\/project\/(\w+)\/statuses$/.exec(path))) {
      if (m[1] === 'OPS')
        return json([
          {
            statuses: [
              { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
              { id: '3', name: 'Done', statusCategory: { key: 'done' } },
            ],
          },
        ]);
      return json([
        {
          name: 'Story',
          statuses: [
            { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
            { id: '3', name: 'Done', statusCategory: { key: 'done' } },
            { id: '2', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
          ],
        },
        {
          name: 'Bug',
          statuses: [
            { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
            { id: '4', name: 'QA', statusCategory: { key: 'indeterminate' } },
          ],
        },
      ]);
    }
    if (path === '/rest/agile/1.0/board') {
      if (q.get('projectKeyOrId') === 'OPS') return json({ values: [], isLast: true });
      return json({
        values: [
          { id: 1, type: 'scrum' },
          { id: 2, type: 'kanban' },
        ],
        isLast: true,
      });
    }
    if (path === '/rest/agile/1.0/board/1/sprint') {
      return Number(q.get('startAt')) === 0
        ? json({
            values: [
              sprint(11, 'closed', 'Sprint 1', {
                startDate: '2024-01-01T00:00:00.000Z',
                endDate: '2024-01-14T00:00:00.000Z',
                completeDate: '2024-01-14T10:00:00.000Z',
              }),
            ],
            isLast: false,
          })
        : json({
            values: [
              sprint(12, 'active', 'Sprint 2', {
                goal: 'Ship it',
                startDate: '2024-01-15T00:00:00.000Z',
                endDate: '2024-01-29T00:00:00.000Z',
              }),
              sprint(13, 'future', 'Sprint 3'),
            ],
            isLast: true,
          });
    }
    if (path === '/rest/agile/1.0/board/2/sprint') return json({ errorMessages: ['The board does not support sprints'] }, 400);
    if (path === '/rest/api/3/search/jql' && method === 'POST') {
      if (jira.rateLimitOnce) {
        jira.rateLimitOnce = false;
        return json({ errorMessages: ['Rate limit'] }, 429, { 'retry-after': '5' });
      }
      const b = JSON.parse(init.body);
      const key = /project = "(\w+)"/.exec(b.jql)[1];
      const all = key === 'WEB' ? WEB_ISSUES : OPS_ISSUES;
      const start = b.nextPageToken ? Number(b.nextPageToken.slice(1)) : 0;
      const slice = all
        .slice(start, start + b.maxResults)
        .map((is) => ({ ...is, fields: Object.fromEntries(Object.entries(is.fields).filter(([k]) => b.fields.includes(k))) }));
      const next = start + b.maxResults;
      return json({ issues: slice, ...(next < all.length ? { nextPageToken: `p${next}`, isLast: false } : { isLast: true }) });
    }
    if ((m = /^\/rest\/api\/3\/issue\/([\w-]+)\/comment$/.exec(path))) {
      const list = COMMENTS[m[1]] || [];
      const start = Number(q.get('startAt')) || 0;
      // one comment a page, to test paging
      return json({ comments: list.slice(start, start + 1), startAt: start, maxResults: 1, total: list.length });
    }
    if ((m = /^\/rest\/api\/3\/issue\/([\w-]+)\/worklog$/.exec(path))) {
      const list = WORKLOGS[m[1]] || [];
      return json({ worklogs: list, startAt: 0, maxResults: 100, total: list.length });
    }
    if (path === '/rest/api/3/attachment/content/A1')
      return new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } });
    return json({ errorMessages: [`no fixture for ${method} ${path}`] }, 404);
  };
  return jira;
}

// ---- setup ----

let ctx, jira, clockMs, bob, carol;
beforeEach(async () => {
  jira = fakeJira();
  clockMs = Date.parse('2026-11-18T12:00:00Z');
  ctx = await withAdmin({
    fetch: (...a) => jira.fetch(...a),
    now: () => clockMs,
    JIRA_IMPORT_PAGE_SIZE: '2',
    JIRA_IMPORT_MAX_QUERIES: '30',
  });
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
  await ctx.admin.post('/api/projects', { key: 'OPS', name: 'Existing ops' });
});

const connect = () => ctx.admin.post('/api/admin/jira-import/connect', { site: 'acme', email: 'admin@acme.example', token: TOKEN });

async function planned(options = {}) {
  const r = await connect();
  expect(r.status).toBe(201);
  const id = r.body.import.id;
  const plan = await ctx.admin.put(`/api/admin/jira-import/${id}/plan`, {
    projects: [
      { jiraKey: 'WEB', targetKey: 'WEB' },
      { jiraKey: 'OPS', targetKey: 'OPS2' },
    ],
    options: { comments: true, closedSprints: false, attachments: true, worklogs: true, createUsers: true, ...options },
  });
  expect(plan.status).toBe(200);
  return id;
}

/** Call /step until the run stops; moves the fake clock past Retry-After waits. */
async function drive(id, max = 300) {
  let r;
  let steps = 0;
  for (; steps < max; steps++) {
    r = await ctx.admin.post(`/api/admin/jira-import/${id}/step`);
    expect(r.status).toBe(200);
    const s = r.body.import.status;
    if (s === 'waiting') clockMs += 6000;
    if (['done', 'ready', 'error', 'cancelled'].includes(s)) break;
  }
  return { imp: r.body.import, steps };
}

const raw = (sql, params = []) => ctx.db.all(sql, params);
const count = async (sql, params = []) => (await ctx.db.get(sql, params)).n;

// ---- tests ----

describe('helpers', () => {
  it('converts ADF to Markdown', () => {
    const md = adfToMarkdown(WEB_ISSUES[1].fields.description);
    expect(md).toContain('Hi @Bob Jira, see [docs](https://example.com)');
    expect(md).toContain('- [ ] write tests\n- [x] plan');
    expect(md).toContain('```js\nconst a = 1;\n```');
    expect(md).toContain('[Attachment: screen.png]');
    expect(adfToMarkdown(WEB_ISSUES[0].fields.description)).toBe('## Goal\n\n- first\n- **second**');
    const nested = doc(
      {
        type: 'orderedList',
        attrs: { order: 3 },
        content: [
          { type: 'listItem', content: [p(tx('a')), { type: 'bulletList', content: [{ type: 'listItem', content: [p(tx('b'))] }] }] },
        ],
      },
      { type: 'blockquote', content: [p(tx('quoted ')), p(tx('x', [{ type: 'code' }]), tx(' and '), tx('gone', [{ type: 'strike' }]))] },
      { type: 'rule' },
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', content: [p(tx('H'))] },
              { type: 'tableHeader', content: [p(tx('I'))] },
            ],
          },
          {
            type: 'tableRow',
            content: [
              { type: 'tableCell', content: [p(tx('a|b'))] },
              { type: 'tableCell', content: [p(tx('c'))] },
            ],
          },
        ],
      },
    );
    expect(adfToMarkdown(nested)).toBe('3. a\n   - b\n\n> quoted\n>\n> `x` and ~~gone~~\n\n---\n\n| H | I |\n| --- | --- |\n| a\\|b | c |');
    expect(adfToMarkdown(null)).toBe('');
    expect(adfToMarkdown('plain')).toBe('plain');
  });

  it('cleans sites, suggests keys, maps priorities', () => {
    expect(cleanSite('acme')).toBe(SITE);
    expect(cleanSite('https://acme.atlassian.net/jira/your-work')).toBe(SITE);
    expect(cleanSite('https://evil.example.com')).toBe(null);
    expect(cleanSite('http://acme.atlassian.net')).toBe(null);
    expect(suggestKey('OPS', new Set(['OPS']))).toBe('OPS2');
    expect(suggestKey('my_proj', new Set())).toBe('MYPROJ');
    expect(['Blocker', 'Critical', 'Major', 'Minor', 'Trivial', 'Highest', 'Odd'].map(mapPriority)).toEqual([
      'highest',
      'high',
      'medium',
      'low',
      'lowest',
      'highest',
      'medium',
    ]);
  });
});

describe('Jira import', () => {
  it('connects and lists projects with free keys', async () => {
    const bad = await ctx.admin.post('/api/admin/jira-import/connect', { site: 'acme', email: 'admin@acme.example', token: 'wrong' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('did not accept');
    expect(
      (await ctx.admin.post('/api/admin/jira-import/connect', { site: 'https://evil.example.com', email: 'a@b.c', token: 'x' })).status,
    ).toBe(400);

    const r = await connect();
    expect(r.status).toBe(201);
    expect(r.body.import).toMatchObject({ site: SITE, jiraUser: 'Ada in Jira', status: 'connected', hasCredentials: true });
    expect(r.body.projects).toEqual([
      { id: '10000', key: 'WEB', name: 'Website', keyFree: true, targetKey: 'WEB' },
      { id: '10001', key: 'OPS', name: 'Operations', keyFree: false, targetKey: 'OPS2' },
    ]);
    expect(JSON.stringify(r.body)).not.toContain(TOKEN);
    const got = await ctx.admin.get(`/api/admin/jira-import/${r.body.import.id}`);
    expect(JSON.stringify(got.body)).not.toContain(TOKEN);
    expect(got.body.import.jiraProjects.map((x) => x.targetKey)).toEqual(['WEB', 'OPS2']);

    // plan checks
    const id = r.body.import.id;
    expect((await ctx.admin.put(`/api/admin/jira-import/${id}/plan`, { projects: [{ jiraKey: 'OPS', targetKey: 'OPS' }] })).status).toBe(
      409,
    );
    expect((await ctx.admin.put(`/api/admin/jira-import/${id}/plan`, { projects: [{ jiraKey: 'WEB', targetKey: 'x' }] })).status).toBe(400);
    expect((await ctx.admin.put(`/api/admin/jira-import/${id}/plan`, { projects: [{ jiraKey: 'NOPE', targetKey: 'NOPE' }] })).status).toBe(
      400,
    );
  });

  it('dry run counts issues, sprints, statuses, people and big files without writing', async () => {
    const id = await planned();
    expect((await ctx.admin.post(`/api/admin/jira-import/${id}/dry-run`)).status).toBe(200);
    const { imp } = await drive(id);
    expect(imp.status).toBe('ready');
    const [web, ops] = imp.dryRun.projects;
    expect(web).toMatchObject({
      jiraKey: 'WEB',
      issues: 5,
      epics: 1,
      subtasks: 1,
      statuses: 4,
      sprints: { closed: 1, active: 1, future: 1 },
      attachments: 2,
      tooBigCount: 1,
    });
    expect(web.attachmentsTooBig).toEqual([{ issue: 'WEB-2', filename: 'big.zip', size: 11 * MB }]);
    expect(ops).toMatchObject({ jiraKey: 'OPS', targetKey: 'OPS2', issues: 1, sprints: { closed: 0, active: 0, future: 0 } });
    expect(imp.dryRun.totals).toMatchObject({ issues: 6, epics: 1, subtasks: 1, sprints: 3, attachmentsTooBig: 1 });
    expect(imp.dryRun.people).toMatchObject({ matched: 2, unmatched: 2 });
    const byName = Object.fromEntries(imp.dryRun.people.list.map((x) => [x.name, x]));
    expect(byName['Bob Jira']).toMatchObject({ matched: true, how: 'email' });
    expect(byName.Carol).toMatchObject({ matched: true, how: 'name' });
    expect(byName['Zed Outside']).toMatchObject({ matched: false, email: 'zed@outside.example' });
    expect(byName.Ghost).toMatchObject({ matched: false, email: null });
    // nothing written, credentials kept for the import
    expect(await count(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM projects WHERE key IN ('WEB', 'OPS2')`)).toBe(0);
    expect(await count('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM jira_import_map')).toBe(0);
    expect((await ctx.db.get('SELECT jira_token FROM jira_imports WHERE id = ?', [id])).jira_token).toBe(TOKEN);
    expect(jira.calls.some((c) => c.includes('/comment') || c.includes('/attachment/'))).toBe(false);
  });

  it('imports step by step: numbers, statuses, sprints, people, comments, links, files, then removes the credentials', async () => {
    const id = await planned();
    await ctx.admin.post(`/api/admin/jira-import/${id}/dry-run`);
    await drive(id);
    expect((await ctx.admin.post(`/api/admin/jira-import/${id}/start`)).status).toBe(200);
    jira.rateLimitOnce = true;
    const { imp, steps } = await drive(id);
    expect(imp.status).toBe('done');
    expect(imp.error).toBe(null);
    expect(steps).toBeGreaterThan(5); // done in slices
    expect(imp.progress.rateLimited).toBe(1);
    expect(imp.hasCredentials).toBe(false);
    expect(await ctx.db.get('SELECT jira_email, jira_token FROM jira_imports WHERE id = ?', [id])).toEqual({
      jira_email: null,
      jira_token: null,
    });
    expect(imp.report).toMatchObject({
      projects: 2,
      issues: 6,
      comments: 2,
      sprints: 2,
      links: 2,
      attachments: 1,
      attachmentsSkipped: 1,
      worklogs: 1,
      usersCreated: 1,
    });
    expect(imp.report.unmatched.map((x) => x.name).sort()).toEqual(['Ghost', 'Outsider']);
    expect(imp.errors.items.some((e) => e.key === 'WEB-2' && e.message.includes('big.zip'))).toBe(true);
    expect(jira.calls.some((c) => c.includes('attachment/content/A2'))).toBe(false);

    // statuses copied, categories from statusCategory
    const web = (await ctx.admin.get('/api/projects/WEB')).body.project;
    expect(web.statuses.map((s) => [s.name, s.category])).toEqual([
      ['To Do', 'todo'],
      ['In Progress', 'in_progress'],
      ['QA', 'in_progress'],
      ['Done', 'done'],
    ]);
    // sprints: closed ones left out
    const sprints = (await ctx.admin.get('/api/projects/WEB/sprints')).body.sprints;
    expect(sprints.map((s) => [s.name, s.state]).sort()).toEqual([
      ['Sprint 2', 'active'],
      ['Sprint 3', 'future'],
    ]);
    expect(sprints.find((s) => s.name === 'Sprint 2')).toMatchObject({ goal: 'Ship it', startDate: '2024-01-15', endDate: '2024-01-29' });

    // Jira numbers kept (WEB-3 does not exist)
    expect((await ctx.admin.get('/api/issues/WEB-3')).status).toBe(404);
    const epic = (await ctx.admin.get('/api/issues/WEB-1')).body.issue;
    expect(epic).toMatchObject({
      type: 'epic',
      title: 'Epic one',
      description: '## Goal\n\n- first\n- **second**',
      reporter: { name: 'Bob' },
    });
    const story = (await ctx.admin.get('/api/issues/WEB-2')).body.issue;
    expect(story).toMatchObject({
      type: 'story',
      parent: { key: 'WEB-1' },
      assignee: { name: 'Bob' },
      reporter: { name: 'Carol' },
      priority: 'highest',
      status: { name: 'In Progress', category: 'in_progress' },
      sprint: { name: 'Sprint 2' },
      storyPoints: 5,
      estimateHours: 2,
      dueDate: '2024-03-01',
      labels: ['needs-review', 'ui'],
      createdAt: '2024-01-05T10:00:00.000Z',
      resolvedAt: null,
    });
    expect(story.description).toContain('- [ ] write tests');
    expect(story.history[0]).toMatchObject({ field: 'created', to: 'Imported from Jira WEB-2', createdAt: '2024-01-05T10:00:00.000Z' });
    // comments keep author and time; unmatched authors are named in the text
    expect(story.comments.map((c) => [c.author?.name ?? null, c.body, c.createdAt])).toEqual([
      ['Bob', 'Looks good', '2024-02-01T10:00:00.000Z'],
      [null, 'Originally by Outsider:\n\nFrom outside', '2024-02-02T10:00:00.000Z'],
    ]);
    // links: blocks inside the project, relates across projects
    expect(story.links.map((l) => [l.type, l.direction, l.issue.key]).sort()).toEqual([
      ['blocks', 'out', 'WEB-5'],
      ['relates', 'in', 'OPS2-1'],
    ]);
    // attachment under 10 MB copied
    expect(story.attachments.map((a) => [a.filename, a.size, a.uploadedBy?.name])).toEqual([['notes.txt', 5, 'Bob']]);
    const file = await ctx.app.request(story.attachments[0].url, { headers: { cookie: '' } }, ctx.env);
    expect(file.status).toBe(401); // needs a session
    const dl = await ctx.admin.get(story.attachments[0].url);
    expect(dl.body).toBe('hello');

    // sub-task imported before its parent: fixed in the parents stage
    const sub = (await ctx.admin.get('/api/issues/WEB-4')).body.issue;
    expect(sub).toMatchObject({ type: 'subtask', parent: { key: 'WEB-5' } });
    const task = (await ctx.admin.get('/api/issues/WEB-5')).body.issue;
    expect(task).toMatchObject({
      status: { category: 'done' },
      resolvedAt: '2024-02-10T12:00:00.000Z',
      assignee: { name: 'Zed Outside' },
      reporter: null,
      parent: { key: 'WEB-1' },
    });
    expect(task.worklogs).toMatchObject([{ hours: 1, workDate: '2024-02-03', note: 'Fixing', user: { name: 'Bob' } }]);
    const zed = await ctx.db.get(`SELECT status, role FROM users WHERE email = 'zed@outside.example'`);
    expect(zed).toEqual({ status: 'invited', role: 'member' });
    const bug = (await ctx.admin.get('/api/issues/WEB-6')).body.issue;
    expect(bug).toMatchObject({ type: 'bug', priority: 'lowest', status: { name: 'QA' }, sprint: null });

    // renumbered project
    const ops = (await ctx.admin.get('/api/issues/OPS2-1')).body.issue;
    expect(ops).toMatchObject({ title: 'Ops seven', projectKey: 'OPS2' });
    // the sequences continue after the import
    expect((await ctx.admin.post('/api/issues', { projectKey: 'WEB', title: 'After' })).body.issue.key).toBe('WEB-7');
    expect((await ctx.admin.post('/api/issues', { projectKey: 'OPS2', title: 'After' })).body.issue.key).toBe('OPS2-2');
    // the existing OPS project is untouched
    expect((await ctx.admin.get('/api/issues?project=OPS')).body.total).toBe(0);

    // audit
    const audit = (await ctx.admin.get('/api/admin/audit')).body.entries.map((e) => e.action);
    expect(audit).toContain('jira_import.started');
    expect(audit).toContain('jira_import.finished');

    // idempotent: running the issue stages again (as after a lost step) adds nothing
    const before = await raw(`SELECT
      (SELECT CAST(COUNT(*) AS INTEGER) FROM issues) AS issues, (SELECT CAST(COUNT(*) AS INTEGER) FROM comments) AS comments,
      (SELECT CAST(COUNT(*) AS INTEGER) FROM issue_links) AS links, (SELECT CAST(COUNT(*) AS INTEGER) FROM sprints) AS sprints,
      (SELECT CAST(COUNT(*) AS INTEGER) FROM attachments) AS files, (SELECT CAST(COUNT(*) AS INTEGER) FROM projects) AS projects,
      (SELECT CAST(COUNT(*) AS INTEGER) FROM worklogs) AS worklogs, (SELECT CAST(COUNT(*) AS INTEGER) FROM statuses) AS statuses`);
    await ctx.db.run(
      `UPDATE jira_imports SET status = 'running', stage = 'project', jira_email = 'admin@acme.example', jira_token = ?, state = ? WHERE id = ?`,
      [
        TOKEN,
        JSON.stringify({
          ...JSON.parse((await ctx.db.get('SELECT state FROM jira_imports WHERE id = ?', [id])).state),
          pi: 0,
          token: null,
          offset: 0,
        }),
        id,
      ],
    );
    const again = await drive(id);
    expect(again.imp.status).toBe('done');
    expect(
      await raw(`SELECT
      (SELECT CAST(COUNT(*) AS INTEGER) FROM issues) AS issues, (SELECT CAST(COUNT(*) AS INTEGER) FROM comments) AS comments,
      (SELECT CAST(COUNT(*) AS INTEGER) FROM issue_links) AS links, (SELECT CAST(COUNT(*) AS INTEGER) FROM sprints) AS sprints,
      (SELECT CAST(COUNT(*) AS INTEGER) FROM attachments) AS files, (SELECT CAST(COUNT(*) AS INTEGER) FROM projects) AS projects,
      (SELECT CAST(COUNT(*) AS INTEGER) FROM worklogs) AS worklogs, (SELECT CAST(COUNT(*) AS INTEGER) FROM statuses) AS statuses`),
    ).toEqual(before);
  });

  it('imports without the dry run and leaves unmatched people unassigned', async () => {
    const id = await planned({ attachments: false, worklogs: false, comments: false, createUsers: false, closedSprints: true });
    await ctx.admin.post(`/api/admin/jira-import/${id}/start`);
    const { imp } = await drive(id);
    expect(imp.status).toBe('done');
    expect(imp.report).toMatchObject({ issues: 6, comments: 0, attachments: 0, sprints: 3 });
    expect(await ctx.db.get(`SELECT id FROM users WHERE email = 'zed@outside.example'`)).toBe(null);
    const task = (await ctx.admin.get('/api/issues/WEB-5')).body.issue;
    expect(task.assignee).toBe(null);
    const bug = (await ctx.admin.get('/api/issues/WEB-6')).body.issue;
    expect(bug.sprint).toMatchObject({ name: 'Sprint 1' }); // closed sprints included
    expect(jira.calls.some((c) => c.includes('/comment') || c.includes('/worklog'))).toBe(false);
  });

  it('cancel stops the run and deletes the credentials', async () => {
    const id = await planned();
    await ctx.admin.post(`/api/admin/jira-import/${id}/start`);
    await ctx.admin.post(`/api/admin/jira-import/${id}/step`);
    const c = await ctx.admin.post(`/api/admin/jira-import/${id}/cancel`);
    expect(c.status).toBe(200);
    expect(c.body.import).toMatchObject({ status: 'cancelled', hasCredentials: false });
    expect((await ctx.db.get('SELECT jira_token FROM jira_imports WHERE id = ?', [id])).jira_token).toBe(null);
    const calls = jira.calls.length;
    const s = await ctx.admin.post(`/api/admin/jira-import/${id}/step`);
    expect(s.body.import.status).toBe('cancelled');
    expect(jira.calls.length).toBe(calls);
    expect((await ctx.admin.post(`/api/admin/jira-import/${id}/cancel`)).status).toBe(400);
    const audit = (await ctx.admin.get('/api/admin/audit')).body.entries.map((e) => e.action);
    expect(audit).toContain('jira_import.cancelled');
    const list = await ctx.admin.get('/api/admin/jira-import');
    expect(list.body.imports[0]).toMatchObject({ id, status: 'cancelled' });
  });

  it('is for admins only', async () => {
    const id = await planned();
    for (const [m, path, data] of [
      ['get', '/api/admin/jira-import'],
      ['post', '/api/admin/jira-import/connect', { site: 'acme', email: 'admin@acme.example', token: TOKEN }],
      ['get', `/api/admin/jira-import/${id}`],
      ['put', `/api/admin/jira-import/${id}/plan`, { projects: [] }],
      ['post', `/api/admin/jira-import/${id}/start`],
      ['post', `/api/admin/jira-import/${id}/step`],
      ['post', `/api/admin/jira-import/${id}/cancel`],
    ]) {
      expect((await bob.client[m](path, data)).status).toBe(403);
    }
    expect((await ctx.db.get('SELECT status FROM jira_imports WHERE id = ?', [id])).status).toBe('planned');
    expect(carol.id).toBeTruthy();
  });
});
