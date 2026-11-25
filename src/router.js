import { createRouter, createWebHistory } from 'vue-router';
import { session, loadMe, setUnauthorizedHandler } from './api.js';

const PUBLIC = ['login', 'setup', 'invite'];

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: () => import('./views/LoginView.vue') },
    { path: '/setup', name: 'setup', component: () => import('./views/SetupView.vue') },
    { path: '/invite/:token', name: 'invite', component: () => import('./views/InviteView.vue') },
    { path: '/', name: 'home', component: () => import('./views/HomeView.vue') },
    { path: '/projects', name: 'projects', component: () => import('./views/ProjectsView.vue') },
    { path: '/portfolio', name: 'portfolio', component: () => import('./views/PortfolioPage.vue') },
    { path: '/projects/:key/status/:id/print', name: 'status-print', component: () => import('./views/project/StatusPrintView.vue') }, // no app chrome (App.vue)
    {
      path: '/projects/:key',
      component: () => import('./views/project/ProjectLayout.vue'),
      children: [
        { path: '', redirect: (to) => `/projects/${to.params.key}/board` },
        { path: 'board', name: 'board', component: () => import('./views/project/BoardView.vue') },
        { path: 'backlog', name: 'backlog', component: () => import('./views/project/BacklogView.vue') },
        { path: 'issues', name: 'project-issues', component: () => import('./views/project/ProjectIssues.vue') },
        { path: 'activity', name: 'project-activity', component: () => import('./views/project/ActivityView.vue') },
        { path: 'roadmap', name: 'project-roadmap', component: () => import('./views/project/RoadmapView.vue') },
        { path: 'calendar', name: 'project-calendar', component: () => import('./views/project/ProjectCalendar.vue') },
        { path: 'releases', name: 'project-releases', component: () => import('./views/project/ReleasesView.vue') },
        { path: 'releases/:id', name: 'project-release', component: () => import('./views/project/ReleaseView.vue') },
        { path: 'status', name: 'project-status', component: () => import('./views/project/StatusView.vue') },
        { path: 'status/:id', name: 'project-status-report', component: () => import('./views/project/StatusView.vue') },
        { path: 'raid', name: 'project-raid', component: () => import('./views/project/RaidView.vue') },
        { path: 'reports', name: 'project-reports', component: () => import('./views/project/ReportsView.vue') },
        { path: 'recurring', name: 'project-recurring', component: () => import('./views/project/RecurringView.vue') },
        { path: 'settings', name: 'project-settings', component: () => import('./views/project/ProjectSettings.vue') },
      ],
    },
    { path: '/browse/:key', name: 'issue', component: () => import('./views/IssueView.vue') },
    { path: '/issues', name: 'search', component: () => import('./views/SearchView.vue') },
    { path: '/roadmap', name: 'roadmap', component: () => import('./views/RoadmapPage.vue') },
    { path: '/calendar', name: 'calendar', component: () => import('./views/CalendarPage.vue') },
    { path: '/capacity', name: 'capacity', component: () => import('./views/CapacityView.vue') },
    { path: '/timesheet', name: 'timesheet', component: () => import('./views/TimesheetView.vue') },
    { path: '/timesheet/approvals', name: 'timesheet-approvals', component: () => import('./views/TimesheetView.vue') },
    { path: '/reports', name: 'reports', component: () => import('./views/reports/ReportsPage.vue') },
    { path: '/reports/standard/:id', name: 'standard-report', component: () => import('./views/reports/StandardReportView.vue') },
    { path: '/reports/new', name: 'report-new', component: () => import('./views/reports/ReportBuilder.vue') },
    { path: '/reports/dashboards/:id', name: 'dashboard', component: () => import('./views/reports/DashboardView.vue') },
    { path: '/reports/:id/edit', name: 'report-edit', component: () => import('./views/reports/ReportBuilder.vue') },
    { path: '/reports/:id', name: 'report', component: () => import('./views/reports/ReportView.vue') },
    { path: '/trash', name: 'trash', component: () => import('./views/TrashView.vue') },
    { path: '/help', name: 'help', component: () => import('./views/HelpView.vue') },
    { path: '/digest', name: 'digest', component: () => import('./views/DigestView.vue') },
    { path: '/ai', name: 'ai-connectors', component: () => import('./views/AiConnectorsView.vue') },
    { path: '/profile', name: 'profile', component: () => import('./views/ProfileView.vue') },
    {
      path: '/admin',
      component: () => import('./views/admin/AdminLayout.vue'), // heading and tabs once, the page under them
      children: [
        { path: '', redirect: '/admin/users' },
        { path: 'users', name: 'admin-users', component: () => import('./views/admin/AdminUsers.vue') },
        { path: 'feedback', name: 'admin-feedback', component: () => import('./views/admin/AdminFeedback.vue') },
        { path: 'settings', name: 'admin-settings', component: () => import('./views/admin/AdminSettings.vue') },
        { path: 'templates', name: 'admin-templates', component: () => import('./views/admin/AdminTemplates.vue') },
        { path: 'slack', name: 'admin-slack', component: () => import('./views/admin/AdminSlack.vue') },
        { path: 'webhooks', name: 'admin-webhooks', component: () => import('./views/admin/AdminWebhooks.vue') },
        { path: 'backups', name: 'admin-backups', component: () => import('./views/admin/AdminBackups.vue') },
        { path: 'jira-import', name: 'admin-jira-import', component: () => import('./views/admin/AdminJiraImport.vue') },
        { path: 'audit', name: 'admin-audit', component: () => import('./views/admin/AdminAudit.vue') },
        { path: 'mcp', name: 'admin-mcp', component: () => import('./views/admin/AdminMcpAudit.vue') },
      ],
    },
    { path: '/:pathMatch(.*)*', name: 'notfound', component: () => import('./views/NotFound.vue') },
  ],
});

router.beforeEach(async (to) => {
  if (!session.loaded) await loadMe();
  if (PUBLIC.includes(to.name)) return true;
  if (!session.user) return { name: 'login', query: to.fullPath !== '/' ? { next: to.fullPath } : {} };
  // Admins who must turn on two-factor sign-in first (Admin > Settings > Security) only reach their profile.
  if (session.twoFactorRequired && to.name !== 'profile') return { name: 'profile' };
  if (to.path.startsWith('/admin') && session.user.role !== 'admin') return { name: 'home' };
  // Guests (external clients) have no AI connectors, API tokens, Trash, Capacity or RAID log.
  if (
    session.user.role === 'guest' &&
    (to.path.startsWith('/ai') ||
      to.path.startsWith('/trash') ||
      to.path.startsWith('/capacity') ||
      /^\/projects\/[^/]+\/raid/.test(to.path))
  )
    return { name: 'home' };
  return true;
});

setUnauthorizedHandler(() => {
  const cur = router.currentRoute.value;
  if (!PUBLIC.includes(cur.name)) router.push({ name: 'login', query: { next: cur.fullPath } });
});
