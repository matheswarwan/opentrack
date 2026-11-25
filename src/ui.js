import { reactive } from 'vue';
import { forgetProjects } from './projects.js';

// App-wide UI state: the Create issue dialog, a change counter views watch to reload, and the issue drawer.
export const ui = reactive({
  create: null, // null = closed, else defaults { projectKey, type, parentKey, sprintId, statusId }
  changes: 0,
  lastProjectKey: null,
  projects: 0,
});

export function openCreate(defaults = {}) {
  ui.create = { projectKey: defaults.projectKey || ui.lastProjectKey || '', ...defaults };
}

export function changed() {
  ui.changes++;
}

// The issue drawer (IssueDrawer, mounted once in App.vue) shows the issue named in the URL's ?issue=KEY, on
// any page. main.js hands over the router once at startup.
let router = null;
export function bindRouter(r) {
  router = r;
}
const setIssue = (key) => router.replace({ query: { ...router.currentRoute.value.query, issue: key } });
export const openIssue = (key) => setIssue(key);
export const closeIssue = () => setIssue(undefined);

// Projects were added, deleted or restored: the project store (projects.js) forgets what it has and the
// sidebar's project switcher reloads its list.
export function projectsChanged() {
  forgetProjects();
  ui.projects = (ui.projects || 0) + 1;
}
