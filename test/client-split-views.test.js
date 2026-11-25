// The pages that were split into a thin shell and one component per mode: Timesheet (week, approvals),
// project Status (list, report), the issue search (all projects, one project) and the report builder's step 1.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createSSRApp, h, ref, reactive } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createRouter, createMemoryHistory } from 'vue-router';
import { session } from '../src/api.js';
import { QUICK_KEYS, blankSourceForm, sourceOf, sourceFormOf, sourceProjectOf } from '../src/reports.js';
import TimesheetWeek from '../src/components/timesheet/TimesheetWeek.vue';
import TimesheetApprovals from '../src/components/timesheet/TimesheetApprovals.vue';
import StatusList from '../src/components/status/StatusList.vue';
import StatusReport from '../src/components/status/StatusReport.vue';
import ReportSource from '../src/components/reports/ReportSource.vue';
import SearchView from '../src/views/SearchView.vue';
import ProjectIssues from '../src/views/project/ProjectIssues.vue';

const PROJECT = {
  id: 'p1',
  key: 'WEB',
  name: 'Website',
  canEdit: true,
  canAdmin: true,
  statuses: [],
  fields: [],
  components: [],
  releases: [],
};

beforeAll(() => {
  session.loaded = true;
  session.user = { id: 'u1', name: 'Ann Lee', email: 'ann@example.com', role: 'admin' };
  vi.stubGlobal('fetch', () => new Promise(() => {})); // never answers
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
});
afterAll(() => {
  vi.unstubAllGlobals();
  session.user = null;
});

async function render(component, props = {}, path = '/somewhere') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:all(.*)*', name: 'page', component: { render: () => null } }],
  });
  await router.push(path);
  await router.isReady();
  const errors = [];
  const app = createSSRApp({ render: () => h(component, props) });
  app.use(router);
  app.provide('project', ref(PROJECT));
  app.config.errorHandler = (e) => errors.push(e);
  app.config.warnHandler = (msg) => errors.push(new Error(msg));
  const html = await renderToString(app);
  expect(errors.map((e) => e.message)).toEqual([]);
  return html;
}
const noop = async () => {};

describe('report source form (src/reports.js)', () => {
  it('starts as Issues matching with every quick field empty', () => {
    const form = blankSourceForm();
    expect(form.mode).toBe('matching');
    expect(Object.keys(form.quick)).toEqual(QUICK_KEYS);
    expect(sourceOf(form)).toEqual({ query: {} });
  });
  it('a saved filter is the source only once one is chosen', () => {
    const form = { ...blankSourceForm(), mode: 'filter' };
    expect(sourceOf(form)).toBe(null);
    form.filterId = 'f1';
    expect(sourceOf(form)).toEqual({ filterId: 'f1' });
  });
  it('project mode: one project or all', () => {
    expect(sourceOf({ ...blankSourceForm(), mode: 'project', projectKey: 'WEB' })).toEqual({ query: { project: 'WEB' } });
    expect(sourceOf({ ...blankSourceForm(), mode: 'project' })).toEqual({ query: {} });
  });
  it('matching mode sends the filled quick fields as text and keeps the extra query keys', () => {
    const form = blankSourceForm();
    Object.assign(form.quick, { category: 'todo,in_progress', dueWithinDays: 7, label: '' });
    form.extraQuery = { component: 'c1' };
    expect(sourceOf(form)).toEqual({ query: { component: 'c1', category: 'todo,in_progress', dueWithinDays: '7' } });
  });
  it('reads a saved source back into the form', () => {
    expect(sourceFormOf({ filterId: 'f1' })).toMatchObject({ mode: 'filter', filterId: 'f1' });
    expect(sourceFormOf({ query: { project: 'WEB' } })).toMatchObject({ mode: 'project', projectKey: 'WEB' });
    expect(sourceFormOf({ query: {} })).toMatchObject({ mode: 'project', projectKey: '' });
    expect(sourceFormOf({})).toMatchObject({ mode: 'project', projectKey: '' });
    const several = sourceFormOf({ query: { project: 'WEB,OPS' } });
    expect(several.mode).toBe('matching');
    expect(several.quick.project).toBe('WEB,OPS');
    const mixed = sourceFormOf({ query: { project: 'WEB', type: 'bug', component: 'c1' } });
    expect(mixed).toMatchObject({ mode: 'matching', extraQuery: { component: 'c1' } });
    expect(mixed.quick).toMatchObject({ project: 'WEB', type: 'bug', category: '' });
  });
  it('a source goes through the form and back unchanged', () => {
    for (const source of [{ filterId: 'f1' }, { query: { project: 'WEB' } }, { query: { type: 'bug', component: 'c1', q: 'login' } }]) {
      expect(sourceOf(sourceFormOf(source))).toEqual(source);
    }
  });
  it('names the one project the form covers', () => {
    expect(sourceProjectOf({ ...blankSourceForm(), mode: 'project', projectKey: 'WEB' })).toBe('WEB');
    expect(sourceProjectOf(sourceFormOf({ query: { project: 'WEB', type: 'bug' } }))).toBe('WEB');
    expect(sourceProjectOf(sourceFormOf({ query: { project: 'WEB,OPS' } }))).toBe('');
    expect(sourceProjectOf({ ...blankSourceForm(), mode: 'filter', projectKey: 'WEB' })).toBe('');
  });
});

describe('ReportSource', () => {
  const lists = {
    filters: [{ id: 'f1', name: 'My bugs', mine: true, shared: false }],
    projects: [{ key: 'WEB', name: 'Website' }],
    people: [{ id: 'u2', name: 'Bob' }],
  };
  it('shows the fields of the chosen mode', async () => {
    const matching = await render(ReportSource, { form: reactive(blankSourceForm()), ...lists });
    expect(matching).toContain('id="b-source"');
    expect(matching).toContain('Due within');
    expect(matching).toContain('Me (Ann Lee)');
    expect(matching).not.toContain('id="b-filter"');
    const filter = await render(ReportSource, { form: reactive({ ...blankSourceForm(), mode: 'filter' }), ...lists });
    expect(filter).toContain('id="b-filter"');
    expect(filter).toContain('My bugs');
    expect(filter).not.toContain('Due within');
    const project = await render(ReportSource, { form: reactive({ ...blankSourceForm(), mode: 'project' }), ...lists });
    expect(project).toContain('id="b-project"');
    expect(project).toContain('Website (WEB)');
  });
  it('says which other conditions a saved report keeps', async () => {
    const html = await render(ReportSource, { form: reactive(sourceFormOf({ query: { type: 'bug', component: 'c1' } })), ...lists });
    expect(html).toContain('Also keeps conditions set elsewhere: component.');
  });
});

describe('Timesheet parts', () => {
  const week = {
    id: 'w1',
    weekStart: '2026-11-16',
    weekEnd: '2026-11-22',
    total: 6.5,
    submittedAt: new Date().toISOString(),
    status: 'submitted',
    user: { id: 'u2', name: 'Bob' },
    projects: [{ key: 'WEB', name: 'Website', hours: 6.5 }],
  };
  it('approvals: skeleton, empty text, then the weeks with labelled buttons', async () => {
    expect(await render(TimesheetApprovals, { approvals: null })).toContain('aria-busy="true"');
    expect(await render(TimesheetApprovals, { approvals: [] })).toContain('No weeks are waiting for you.');
    const html = await render(TimesheetApprovals, { approvals: [week] });
    expect(html).toContain('id="ts-approvals"');
    expect(html).toContain('aria-label="Approve the week of 2026-11-16 of Bob"');
    expect(html).toContain('aria-label="Reject the week of 2026-11-16 of Bob"');
    expect(html).toContain('Open week');
  });
  const days = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'];
  const data = {
    days,
    total: 3,
    nonBillable: 0,
    perDay: { '2026-11-16': 3 },
    canSubmit: true,
    submission: null,
    byProject: [{ key: 'WEB', total: 3 }],
    byIssue: [{ key: 'WEB-1', title: 'Fix login', type: 'bug', total: 3, perDay: { '2026-11-16': 3 } }],
    entries: [
      {
        id: 'e1',
        date: '2026-11-16',
        key: 'WEB-1',
        title: 'Fix login',
        projectKey: 'WEB',
        hours: 3,
        billable: true,
        note: '',
        user: { id: 'u1', name: 'Ann Lee' },
      },
    ],
  };
  const base = { loading: false, loadError: '', load: noop, loadApprovals: noop, start: '2026-11-16', who: 'me' };
  it('week: the load state until the data arrives', async () => {
    const html = await render(TimesheetWeek, { ...base, data: null, loading: true });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Previous week"');
  });
  it('week: grid, submission bar and billable section', async () => {
    const html = await render(TimesheetWeek, { ...base, data });
    expect(html).toContain('This week is not submitted for approval yet.');
    expect(html).toContain('Submit week');
    expect(html).toContain('aria-label="Whose time"');
    expect(html).toContain('WEB-1');
    expect(html).toContain('3 hours on WEB-1 for 2026-11-16. Log more time');
    expect(html).toContain('id="ts-entries"');
    expect(html).toContain('+ Log time on another issue');
  });
  it('week: an approved week is read as locked and the team view has no log buttons', async () => {
    const approved = {
      ...data,
      canSubmit: false,
      submission: {
        id: 'w1',
        status: 'approved',
        locked: true,
        decidedBy: { name: 'Cy' },
        decidedAt: new Date().toISOString(),
        comment: '',
      },
    };
    const html = await render(TimesheetWeek, { ...base, data: approved });
    expect(html).toContain('Approved by Cy');
    expect(html).toContain('Reopen');
    const team = await render(TimesheetWeek, {
      ...base,
      who: 'team',
      data: { ...data, byUser: [{ id: 'u2', name: 'Bob', total: 3, perDay: {} }] },
    });
    expect(team).toContain('Person');
    expect(team).not.toContain('Log time on');
    expect(team).not.toContain('Submit week');
  });
});

describe('Status parts', () => {
  const report = {
    id: 'r1',
    periodStart: '2026-11-09',
    periodEnd: '2026-11-15',
    status: 'draft',
    sharedWithGuests: true,
    rag: { overall: 'green' },
    author: { name: 'Ann Lee' },
  };
  it('list: skeleton, empty text for admins, then the reports', async () => {
    expect(await render(StatusList, { reports: null, canAdmin: false, loadList: noop })).toContain('aria-busy="true"');
    const empty = await render(StatusList, { reports: [], canAdmin: true, loadList: noop });
    expect(empty).toContain('No status reports yet.');
    expect(empty).toContain('New status report');
    const html = await render(StatusList, { reports: [report], canAdmin: false, loadList: noop });
    expect(html).toContain('href="/projects/WEB/status/r1"');
    expect(html).toContain('Overall: Green');
    expect(html).toContain('Shared with guests');
    expect(html).not.toContain('New status report');
  });
  it('report: the skeleton while it loads', async () => {
    expect(await render(StatusReport, { id: 'r1', canAdmin: true, aiAvailable: false, loadList: noop })).toContain('aria-busy="true"');
  });
});

describe('issue search shells', () => {
  it('the Issues page has the heading and the project filter', async () => {
    const html = await render(SearchView, {}, '/issues?project=all');
    expect(html).toContain('<h1 class="mb-3 text-xl font-semibold">Issues</h1>');
    expect(html).toContain('aria-label="Project"');
    expect(html).toContain('aria-label="Quick filters"');
  });
  it('the project tab has neither: the project is fixed', async () => {
    const html = await render(ProjectIssues, {}, '/projects/WEB/issues');
    expect(html).not.toContain('<h1');
    expect(html).not.toContain('aria-label="Project"');
    expect(html).toContain('aria-label="Quick filters"');
  });
});
