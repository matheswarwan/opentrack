// Small shared components and the parts of the issue page, rendered to HTML.
import { describe, it, expect } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import LoadState from '../src/components/LoadState.vue';
import StatusSelect from '../src/components/StatusSelect.vue';
import FieldRow from '../src/components/FieldRow.vue';
import IssueHistory from '../src/components/IssueHistory.vue';
import IssueChildren from '../src/components/IssueChildren.vue';
import IssueDependencies from '../src/components/IssueDependencies.vue';
import IssueLinks from '../src/components/IssueLinks.vue';
import IssueWorklog from '../src/components/IssueWorklog.vue';
import IssueWatchers from '../src/components/IssueWatchers.vue';
import { session } from '../src/api.js';

// RouterLink as a plain link, so the parts render without a router
const RouterLink = {
  props: ['to'],
  render() {
    return h('a', { href: this.to }, this.$slots.default?.());
  },
};
const render = (component, props, slots) =>
  renderToString(createSSRApp({ render: () => h(component, props, slots) }).component('RouterLink', RouterLink));

describe('LoadState', () => {
  const content = { default: () => h('p', 'The content') };
  it('shows the skeleton while loading', async () => {
    const html = await render(LoadState, { loading: true, error: '' }, content);
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('The content');
  });
  it('shows the error with a retry button, never the skeleton', async () => {
    const html = await render(LoadState, { loading: false, error: 'Request failed (500)' }, content);
    expect(html).toContain('role="alert"');
    expect(html).toContain('Could not load: Request failed (500)');
    expect(html).toContain('Try again</button>');
    expect(html).not.toContain('aria-busy');
    expect(html).not.toContain('The content');
  });
  it('shows the content when loaded', async () => {
    const html = await render(LoadState, { loading: false, error: '' }, content);
    expect(html).toContain('<p>The content</p>');
    expect(html).not.toContain('role="alert"');
  });
});

describe('StatusSelect', () => {
  const project = {
    statuses: [
      { id: 's1', name: 'To Do' },
      { id: 's2', name: 'Doing' },
      { id: 's3', name: 'Done' },
    ],
    workflow: { transitions: { s1: ['s2'] }, adminBypass: true },
    canAdmin: false,
  };
  const issue = { key: 'WEB-1', status: { id: 's1' } };
  it('disables the moves the workflow does not allow, and carries its label and classes', async () => {
    const html = await render(StatusSelect, { issue, project, label: 'Status of WEB-1', class: 'input w-auto' });
    expect(html).toMatch(/<select[^>]*class="input w-auto"/);
    expect(html).toContain('aria-label="Status of WEB-1"');
    expect(html).toMatch(/<select[^>]*value="s1"/); // the issue's status is the selected one
    expect(html).toContain('<option value="s1">To Do</option>');
    expect(html).toMatch(/<option value="s2"(?![^>]*disabled)[^>]*>Doing<\/option>/);
    expect(html).toMatch(/<option value="s3"[^>]*disabled[^>]*>Done<\/option>/);
  });
  it('a project admin with bypass can pick any status', async () => {
    const html = await render(StatusSelect, { issue, project: { ...project, canAdmin: true } });
    expect(html).not.toContain('disabled');
    expect(html).toContain('aria-label="Status"');
  });
});

describe('FieldRow', () => {
  it('renders the label and the control in the shared grid', async () => {
    const html = await render(FieldRow, { label: 'Sprint' }, { default: () => h('select', { 'aria-label': 'Sprint' }) });
    expect(html).toContain('grid-cols-[6.5rem_minmax(0,1fr)]');
    expect(html).toContain('items-center');
    expect(html).toContain('<span class="text-slate-500">Sprint</span>');
    expect(html).toContain('<select aria-label="Sprint"></select>');
    expect(await render(FieldRow, { label: 'Watchers', top: true })).toContain('items-start');
  });
});

describe('IssueHistory', () => {
  it('lists changes newest first with from and to', async () => {
    const history = [
      { id: 'h1', field: 'created', from: null, to: null, actor: { name: 'Ann' }, createdAt: '2026-11-18T09:00:00Z' },
      { id: 'h2', field: 'priority', from: 'medium', to: 'high', actor: { name: 'Bob' }, createdAt: '2026-11-19T09:00:00Z', source: 'mcp' },
    ];
    const html = await render(IssueHistory, { history });
    expect(html.indexOf('Bob')).toBeLessThan(html.indexOf('Ann'));
    expect(html).toContain('medium → high');
    expect(html).toContain('via AI assistant');
  });
});

describe('issue page parts', () => {
  const todo = { id: 's1', name: 'To Do', category: 'todo' };
  const done = { id: 's3', name: 'Done', category: 'done' };
  const child = (n, status) => ({
    id: `c${n}`,
    key: `WEB-${n}`,
    title: `Child ${n}`,
    type: 'story',
    status,
    priority: 'medium',
    labels: [],
    assignee: null,
  });
  const issue = {
    key: 'WEB-1',
    projectKey: 'WEB',
    type: 'epic',
    sprint: null,
    children: [child(2, done), child(3, todo)],
    dependencies: [
      {
        from: { key: 'WEB-2', title: 'Child 2', status: done, child: true },
        to: { key: 'WEB-3', title: 'Child 3', status: todo, child: true },
      },
      { from: { hidden: true }, to: { key: 'WEB-2', title: 'Child 2', status: done, child: true } },
    ],
    links: [{ id: 'l1', type: 'blocks', direction: 'out', issue: { key: 'APP-9', title: 'Other', status: todo } }],
    worklogs: [{ id: 'w1', hours: 1.5, workDate: '2026-11-19', user: { name: 'Ann' }, note: 'Review', billable: false, mine: false }],
    watchers: [
      { id: 'u1', name: 'Ann' },
      { id: 'u2', name: 'Bob' },
    ],
  };

  it('children: progress, rows and the quick add only with create rights', async () => {
    const html = await render(IssueChildren, { issue, canCreate: true });
    expect(html).toContain('Issues in this epic');
    expect(html).toContain('1 of 2 done');
    expect(html).toContain('WEB-2');
    expect(html).toContain('aria-label="New child issue title"');
    expect(await render(IssueChildren, { issue, canCreate: false })).not.toContain('New child issue title');
    expect(await render(IssueChildren, { issue: { ...issue, type: 'story', children: [] }, canCreate: true })).toContain('Sub-tasks');
  });
  it('dependencies: blockers first, hidden issues named as such', async () => {
    const html = await render(IssueDependencies, { issue });
    expect(html).toContain('an issue you cannot see');
    expect(html.indexOf('an issue you cannot see')).toBeLessThan(html.indexOf('href="/browse/WEB-3"'));
    expect(await render(IssueDependencies, { issue: { ...issue, dependencies: [] } })).toContain('No issue in this epic blocks');
  });
  it('links: the label of the link type, remove only for editors', async () => {
    const html = await render(IssueLinks, { issue, canEdit: true });
    expect(html).toContain('href="/browse/APP-9"');
    expect(html).toContain('Add link');
    expect(html).toContain('aria-label="Remove link"');
    const readOnly = await render(IssueLinks, { issue, canEdit: false });
    expect(readOnly).not.toContain('Add link');
    expect(readOnly).not.toContain('Remove link');
    expect(await render(IssueLinks, { issue: { ...issue, links: [] }, canEdit: false })).toContain('None');
  });
  it('work log: entries, delete for the author or a project admin', async () => {
    const html = await render(IssueWorklog, { issue, canEdit: true, canAdmin: false });
    expect(html).toContain('1.5h');
    expect(html).toContain('Non-billable');
    expect(html).toContain('Log work');
    expect(html).not.toContain('Delete work log');
    expect(await render(IssueWorklog, { issue, canEdit: false, canAdmin: true })).toContain('aria-label="Delete work log"');
    expect(await render(IssueWorklog, { issue: { ...issue, worklogs: [] }, canEdit: false })).toContain('No work logged.');
  });
  it('watchers: remove yourself always, others only as an editor; add only when allowed', async () => {
    session.user = { id: 'u2', name: 'Bob', role: 'member' };
    const viewer = await render(IssueWatchers, { issue, canEdit: false, canAdd: false });
    expect(viewer).toContain('aria-label="Remove Bob from watchers"');
    expect(viewer).not.toContain('Remove Ann from watchers');
    expect(viewer).not.toContain('Add watcher');
    const editor = await render(IssueWatchers, { issue, canEdit: true, canAdd: true });
    expect(editor).toContain('aria-label="Remove Ann from watchers"');
    expect(editor).toContain('+ Add watcher');
    session.user = null;
  });
});
