// Ready-made reports (like Jira's built-in reports). Each runs as the viewer, for all projects or one.
const OPEN = 'todo,in_progress';
const LIST_COLS = ['key', 'title', 'status', 'assignee', 'priority'];

export const STANDARD_GROUPS = [
  {
    id: 'status',
    title: 'Status and progress',
    reports: [
      {
        id: 'by-status',
        name: 'Issues by status',
        description: 'How all issues split across workflow statuses.',
        kind: 'breakdown',
        query: {},
        options: { groupBy: 'status', metric: 'count', chart: 'pie' },
      },
      {
        id: 'epic-progress',
        name: 'Epic progress',
        description: 'Issues in each epic by to do, in progress and done.',
        kind: 'twoD',
        query: { noSubtasks: '1' },
        options: { rows: 'epic', columns: 'statusCategory', metric: 'count' },
      },
      {
        id: 'points-by-status',
        name: 'Story points by status',
        description: 'Where the estimated effort sits right now.',
        kind: 'breakdown',
        query: {},
        options: { groupBy: 'statusCategory', metric: 'storyPoints', chart: 'bar' },
      },
      {
        id: 'by-type',
        name: 'Issues by type',
        description: 'Stories, tasks, bugs, epics and sub-tasks.',
        kind: 'breakdown',
        query: {},
        options: { groupBy: 'type', metric: 'count', chart: 'pie' },
      },
    ],
  },
  {
    id: 'people',
    title: 'People and workload',
    reports: [
      {
        id: 'workload',
        name: 'Workload by assignee',
        description: 'Open issues, story points and hours per person.',
        kind: 'workload',
        query: {},
        options: { includeDone: false },
      },
      {
        id: 'open-by-assignee',
        name: 'Open issues by assignee',
        description: 'Who holds the open work, including unassigned.',
        kind: 'breakdown',
        query: { category: OPEN },
        options: { groupBy: 'assignee', metric: 'count', chart: 'bar' },
      },
      {
        id: 'status-by-assignee',
        name: 'Status by assignee',
        description: 'Each person against each status (two-dimensional statistics).',
        kind: 'twoD',
        query: { category: OPEN },
        options: { rows: 'assignee', columns: 'status', metric: 'count' },
      },
      {
        id: 'unassigned',
        name: 'Unassigned open issues',
        description: 'Open work nobody has picked up, oldest first.',
        kind: 'list',
        query: { category: OPEN, assignee: 'unassigned' },
        options: { sort: 'created', dir: 'asc', limit: 50, columns: ['key', 'title', 'type', 'priority', 'created'] },
      },
    ],
  },
  {
    id: 'flow',
    title: 'Flow over time',
    reports: [
      {
        id: 'created-resolved-30',
        name: 'Created vs resolved, 30 days',
        description: 'Is the backlog growing or shrinking day by day?',
        kind: 'createdVsResolved',
        query: {},
        options: { period: 'day', days: 30, cumulative: false, chart: 'line' },
      },
      {
        id: 'created-resolved-90',
        name: 'Created vs resolved, 90 days (running totals)',
        description: 'The gap between the lines is work added and not yet finished.',
        kind: 'createdVsResolved',
        query: {},
        options: { period: 'week', days: 90, cumulative: true, chart: 'line' },
      },
      {
        id: 'average-age',
        name: 'Average age of open issues',
        description: 'How old unresolved work is, week by week over 90 days.',
        kind: 'averageAge',
        query: {},
        options: { period: 'week', days: 90 },
      },
      {
        id: 'recently-resolved',
        name: 'Recently resolved',
        description: 'Done in the last 14 days.',
        kind: 'list',
        query: { category: 'done', updatedWithinDays: '14' },
        options: { sort: 'updated', dir: 'desc', limit: 50, columns: ['key', 'title', 'assignee', 'resolved'] },
      },
    ],
  },
  {
    id: 'dates',
    title: 'Dates and risk',
    reports: [
      {
        id: 'overdue',
        name: 'Overdue issues',
        description: 'Open issues past their due date.',
        kind: 'list',
        query: { category: OPEN, dueWithinDays: '-1' },
        options: { sort: 'due', dir: 'asc', limit: 100, columns: ['key', 'title', 'assignee', 'due', 'status'] },
      },
      {
        id: 'due-14',
        name: 'Due in the next 14 days',
        description: 'Open issues with a due date in the next two weeks.',
        kind: 'list',
        query: { category: OPEN, dueWithinDays: '14' },
        options: { sort: 'due', dir: 'asc', limit: 100, columns: ['key', 'title', 'assignee', 'due', 'status'] },
      },
      {
        id: 'due-buckets',
        name: 'Open issues by due date',
        description: 'Overdue, due this week, later, or no date.',
        kind: 'breakdown',
        query: { category: OPEN },
        options: { groupBy: 'dueBucket', metric: 'count', chart: 'bar' },
      },
      {
        id: 'open-by-priority',
        name: 'Open issues by priority',
        description: 'How much urgent work is waiting.',
        kind: 'breakdown',
        query: { category: OPEN },
        options: { groupBy: 'priority', metric: 'count', chart: 'pie' },
      },
      {
        id: 'open-bugs',
        name: 'Open bugs',
        description: 'Every open bug, highest priority first.',
        kind: 'list',
        query: { category: OPEN, type: 'bug' },
        options: { sort: 'priority', dir: 'asc', limit: 100, columns: LIST_COLS },
      },
    ],
  },
  {
    id: 'time',
    title: 'Time tracking',
    reports: [
      {
        id: 'logged-by-assignee',
        name: 'Hours logged by person',
        description: 'Work logged on issues, per assignee.',
        kind: 'breakdown',
        query: {},
        options: { groupBy: 'assignee', metric: 'loggedHours', chart: 'bar' },
      },
      {
        id: 'logged-by-epic',
        name: 'Hours logged by epic',
        description: 'Where the time went, epic by epic.',
        kind: 'breakdown',
        query: {},
        options: { groupBy: 'epic', metric: 'loggedHours', chart: 'bar' },
      },
      {
        id: 'estimate-by-epic',
        name: 'Estimated hours by epic',
        description: 'Compare with hours logged by epic.',
        kind: 'breakdown',
        query: {},
        options: { groupBy: 'epic', metric: 'estimateHours', chart: 'bar' },
      },
      {
        id: 'logged-by-project',
        name: 'Hours logged by project',
        description: 'Time across projects (pick All projects).',
        kind: 'breakdown',
        query: {},
        options: { groupBy: 'project', metric: 'loggedHours', chart: 'pie' },
      },
    ],
  },
  {
    id: 'releases',
    title: 'Releases and components',
    reports: [
      {
        id: 'release-progress',
        name: 'Release progress',
        description: 'Issues in each fix version by to do, in progress and done.',
        kind: 'twoD',
        query: { noSubtasks: '1' },
        options: { rows: 'fixVersion', columns: 'statusCategory', metric: 'count' },
      },
      {
        id: 'release-points',
        name: 'Story points by release',
        description: 'Estimated effort per fix version, by to do, in progress and done.',
        kind: 'twoD',
        query: { noSubtasks: '1' },
        options: { rows: 'fixVersion', columns: 'statusCategory', metric: 'storyPoints' },
      },
      {
        id: 'unscheduled',
        name: 'Open issues without a fix version',
        description: 'Open work not planned for any release.',
        kind: 'list',
        query: { category: OPEN, fixVersion: 'none', noSubtasks: '1' },
        options: { sort: 'priority', dir: 'asc', limit: 100, columns: LIST_COLS },
      },
      {
        id: 'open-by-component',
        name: 'Open issues by component',
        description: 'An issue in two components counts under both.',
        kind: 'breakdown',
        query: { category: OPEN },
        options: { groupBy: 'component', metric: 'count', chart: 'bar' },
      },
      {
        id: 'component-status',
        name: 'Components by status',
        description: 'Each component against to do, in progress and done.',
        kind: 'twoD',
        query: {},
        options: { rows: 'component', columns: 'statusCategory', metric: 'count' },
      },
    ],
  },
  {
    id: 'other',
    title: 'Labels and intake',
    reports: [
      {
        id: 'open-by-label',
        name: 'Open issues by label',
        description: 'An issue with two labels counts under both.',
        kind: 'breakdown',
        query: { category: OPEN },
        options: { groupBy: 'label', metric: 'count', chart: 'bar' },
      },
      {
        id: 'recently-created',
        name: 'Recently created',
        description: 'The 25 newest issues.',
        kind: 'list',
        query: {},
        options: { sort: 'created', dir: 'desc', limit: 25, columns: ['key', 'title', 'type', 'reporter', 'created'] },
      },
      {
        id: 'by-reporter',
        name: 'Issues by reporter',
        description: 'Who raises the most work.',
        kind: 'breakdown',
        query: {},
        options: { groupBy: 'reporter', metric: 'count', chart: 'bar' },
      },
    ],
  },
];

export const STANDARD_REPORTS = STANDARD_GROUPS.flatMap((g) => g.reports.map((r) => ({ ...r, group: g.title })));
export const standardReport = (id) => STANDARD_REPORTS.find((r) => r.id === id);

/** Report definition for the API, for all projects (key '') or one project. */
export function standardDefinition(r, projectKey) {
  return { source: { query: { ...r.query, ...(projectKey ? { project: projectKey } : {}) } }, kind: r.kind, options: r.options };
}
