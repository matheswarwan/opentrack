// The sections of the Help page, in page order. The text of each one is its own component in this folder.
import HelpStart from './HelpStart.vue';
import HelpRoles from './HelpRoles.vue';
import HelpMyWork from './HelpMyWork.vue';
import HelpIssues from './HelpIssues.vue';
import HelpCreate from './HelpCreate.vue';
import HelpBoard from './HelpBoard.vue';
import HelpBacklog from './HelpBacklog.vue';
import HelpSearch from './HelpSearch.vue';
import HelpComments from './HelpComments.vue';
import HelpStatusReports from './HelpStatusReports.vue';
import HelpRaid from './HelpRaid.vue';
import HelpPortfolio from './HelpPortfolio.vue';
import HelpCapacity from './HelpCapacity.vue';
import HelpAi from './HelpAi.vue';
import HelpSlack from './HelpSlack.vue';
import HelpChannelAi from './HelpChannelAi.vue';
import HelpSecurity from './HelpSecurity.vue';
import HelpFeedback from './HelpFeedback.vue';
import HelpFaq from './HelpFaq.vue';
import HelpShortcuts from './HelpShortcuts.vue';
import HelpProjectAdmin from './HelpProjectAdmin.vue';
import HelpProjectTemplates from './HelpProjectTemplates.vue';
import HelpAdminWebhooks from './HelpAdminWebhooks.vue';
import HelpAdminUsers from './HelpAdminUsers.vue';
import HelpAdminSettings from './HelpAdminSettings.vue';
import HelpAdminFeedback from './HelpAdminFeedback.vue';

// Each section: who it is for. 'everyone', 'writers' (members and admins), 'project-admins', 'admins'.
export const SECTIONS = [
  { id: 'start', title: 'Getting started', for: 'everyone', component: HelpStart },
  { id: 'roles', title: 'Roles and what they can do', for: 'everyone', component: HelpRoles },
  { id: 'my-work', title: 'My work and notifications', for: 'everyone', component: HelpMyWork },
  { id: 'issues', title: 'Issues', for: 'everyone', component: HelpIssues },
  { id: 'create', title: 'Creating issues', for: 'writers', component: HelpCreate },
  { id: 'board', title: 'The board', for: 'everyone', component: HelpBoard },
  { id: 'backlog', title: 'Backlog and sprints', for: 'writers', component: HelpBacklog },
  { id: 'search', title: 'Search, filters and export', for: 'everyone', component: HelpSearch },
  { id: 'comments', title: 'Comments, status updates and mentions', for: 'writers', component: HelpComments },
  { id: 'status-reports', title: 'Status reports', for: 'everyone', component: HelpStatusReports },
  { id: 'raid', title: 'RAID log', for: 'staff', component: HelpRaid },
  { id: 'portfolio', title: 'Portfolio', for: 'everyone', component: HelpPortfolio },
  { id: 'capacity', title: 'Capacity', for: 'staff', component: HelpCapacity },
  { id: 'ai', title: 'AI assistants (MCP)', for: 'staff', component: HelpAi },
  { id: 'slack', title: 'Slack', for: 'staff', component: HelpSlack },
  { id: 'channel-ai', title: 'Channel AI sessions', for: 'staff', component: HelpChannelAi },
  { id: 'security', title: 'Security: two-factor sign-in and sessions', for: 'everyone', component: HelpSecurity },
  { id: 'feedback', title: 'Feedback', for: 'everyone', component: HelpFeedback },
  { id: 'faq', title: 'Frequently asked questions', for: 'everyone', component: HelpFaq },
  { id: 'shortcuts', title: 'Keyboard shortcuts', for: 'everyone', component: HelpShortcuts },
  { id: 'project-admin', title: 'Running a project', for: 'project-admins', component: HelpProjectAdmin },
  { id: 'project-templates', title: 'Project templates', for: 'writers', component: HelpProjectTemplates },
  { id: 'admin-webhooks', title: 'Webhooks', for: 'project-admins', component: HelpAdminWebhooks },
  { id: 'admin-users', title: 'Adding and managing people', for: 'admins', component: HelpAdminUsers },
  { id: 'admin-settings', title: 'Workspace settings, Google and Slack', for: 'admins', component: HelpAdminSettings },
  { id: 'admin-feedback', title: 'Feedback and the audit log', for: 'admins', component: HelpAdminFeedback },
];
