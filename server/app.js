import { Hono } from 'hono';
import { ApiError } from './lib/http.js';
import { requireUser } from './lib/session.js';
import { registerAuth } from './routes/auth.js';
import { registerAdmin } from './routes/admin.js';
import { registerProjects } from './routes/projects.js';
import { registerIssues } from './routes/issues.js';
import { registerMe } from './routes/me.js';
import { registerSecurity } from './routes/security.js';
import { registerFeedback } from './routes/feedback.js';
import { registerTokens } from './routes/tokens.js';
import { registerOAuth } from './routes/oauth.js';
import { registerSlack } from './routes/slack.js';
import { registerAvatars } from './routes/avatars.js';
import { registerImport } from './routes/import.js';
import { registerAttachments } from './routes/attachments.js';
import { registerEmail } from './routes/email.js';
import { registerFonts } from './routes/fonts.js';
import { registerFeeds } from './routes/feeds.js';
import { registerTemplates } from './routes/templates.js';
import { registerReports } from './routes/reports.js';
import { registerTimesheet } from './routes/timesheet.js';
import { registerTimeTracking } from './routes/timeTracking.js';
import { registerCustomReports } from './routes/customReports.js';
import { registerJobs, isJobsSecretRequest } from './routes/jobs.js';
import { registerTrash } from './routes/trash.js';
import { registerBackups } from './routes/backups.js';
import { registerJiraImport } from './routes/jiraImport.js';
import { registerRecurring } from './routes/recurring.js';
import { registerRoadmap } from './routes/roadmap.js';
import { registerCustomFields } from './routes/customFields.js';
import { registerReleases } from './routes/releases.js';
import { registerBoardViews } from './routes/boardViews.js';
import { scheduleJobs } from './lib/jobs.js';
import { registerEstimates } from './routes/estimates.js';
import { registerWebhooks } from './routes/webhooks.js';
import { registerSlackCommands } from './routes/slackCommands.js';
import { registerCalendar } from './routes/calendar.js';
import { registerStatusReports } from './routes/statusReports.js';
import { registerProjectTemplates } from './routes/projectTemplates.js';
import { registerPortfolio } from './routes/portfolio.js';
import { registerBudgets } from './routes/budgets.js';
import { registerCapacity } from './routes/capacity.js';
import { registerRaid } from './routes/raid.js';
import { handleMcp } from './mcp.js';

/**
 * The API. Hosts call `app.fetch(request, env)` where env holds:
 *   db                     database adapter (server/db/adapters.js)
 *   SETUP_TOKEN            secret needed to create the first admin
 *   DEMO_MODE              optional, "true" turns on the public read-only demo account (server/lib/demo.js)
 *   GOOGLE_CLIENT_ID/SECRET  turn on Google sign-in
 *   PUBLIC_URL             optional, base URL for invite links and OAuth redirects
 *   SLACK_BOT_TOKEN        optional, Slack bot token (wins over one saved under Admin > Slack)
 *   SLACK_SIGNING_SECRET   optional, Slack app signing secret for /slack/commands and /slack/interactivity (wins over a saved one)
 *   FILES / GCS_BUCKET     optional attachment storage: an R2 binding or a Google Cloud Storage bucket
 *                          (GCS_SERVICE_ACCOUNT key JSON, else the metadata server); default is the database
 *   POSTMARK_SERVER_TOKEN, EMAIL_FROM  optional, turn on email (POSTMARK_STREAM, default outbound)
 *   JOBS_SECRET            optional, lets an external scheduler call /api/admin/jobs/run (JOBS_AUTO=off stops request-triggered runs)
 *   BACKUP_WEBHOOK_URL     optional, the daily backup job POSTs the full JSON backup (gzip) here
 *                          (BACKUP_WEBHOOK_SECRET is sent as the X-Backup-Secret header)
 *   GCS_BACKUP_BUCKET      optional, or the daily backup goes to this Google Cloud Storage bucket (same auth as GCS_BUCKET)
 *   JIRA_IMPORT_MAX_QUERIES / JIRA_IMPORT_MAX_FETCHES  optional, work per Jira import step (default 40/40 on D1; raise on a paid plan)
 *   AI_PROVIDER            optional, channel AI sessions: vertex (VERTEX_AI_PROJECT_ID, VERTEX_AI_LOCATION, VERTEX_AI_CREDENTIALS_JSON),
 *                          gemini (GEMINI_API_KEY) or anthropic (ANTHROPIC_API_KEY); AI_MODEL, AI_TIMEOUT_MS, AI_MAX_INPUT_CHARS (server/lib/ai.js)
 */
export function createApp() {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.message, ...(err.extra || {}) }, err.status);
    if (err?.status && err.getResponse) return err.getResponse();
    console.error(err);
    return c.json({ error: 'Something went wrong on the server' }, 500);
  });

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
    c.header('X-Frame-Options', 'DENY');
    if (c.req.path.startsWith('/api/') && !/^\/api\/(users\/[^/]+\/avatar|attachments\/[^/]+|auth\/fonts\/[^/]+)$/.test(c.req.path))
      c.header('Cache-Control', 'no-store');
  });

  app.get('/api/health', (c) => c.json({ ok: true }));
  app.use('/api/*', async (c, next) => {
    if (c.req.path.startsWith('/api/auth/') || c.req.path === '/api/health') {
      if (c.req.method !== 'GET' && c.req.header('x-requested-with') !== 'opentrack') {
        return c.json({ error: 'Missing X-Requested-With header' }, 403);
      }
      return next();
    }
    if (isJobsSecretRequest(c)) {
      c.set('jobsSecret', true);
      return next();
    }
    return requireUser()(c, next);
  });
  app.use('/api/*', async (c, next) => {
    await next();
    // Due-date reminders, digest, recurring issues, trash purge, backups (server/lib/jobs.js). Only light
    // requests start a slice: D1 allows about 50 queries per invocation, and a job shares it with the request.
    // The notification bell calls /api/me every minute, so jobs still run promptly.
    const light = c.req.method === 'GET' && (c.req.path === '/api/me' || c.req.path === '/api/notifications');
    if (c.get('user') && !c.get('skipJobs') && light) scheduleJobs(c);
  });

  registerAuth(app); // public: /api/auth/*, /auth/google*
  registerMe(app);
  registerSecurity(app); // sessions and two-factor sign-in (Profile), admin reset and sign out everywhere
  registerAdmin(app);
  registerProjects(app);
  registerIssues(app);
  registerFeedback(app);
  registerTokens(app);
  registerOAuth(app); // public: /.well-known/*, /oauth/*
  registerSlack(app);
  registerAvatars(app);
  registerFonts(app); // public: GET /api/auth/fonts/<id>
  registerImport(app);
  registerAttachments(app);
  registerEmail(app);
  registerFeeds(app); // public: /feeds/<token>.csv
  registerTemplates(app);
  registerReports(app);
  registerTimesheet(app);
  registerTimeTracking(app);
  registerCustomReports(app);
  registerJobs(app);
  registerTrash(app);
  registerBackups(app);
  registerJiraImport(app);
  registerRecurring(app);
  registerRoadmap(app);
  registerCustomFields(app);
  registerEstimates(app);
  registerReleases(app);
  registerBoardViews(app);
  registerWebhooks(app);
  registerStatusReports(app);
  registerProjectTemplates(app);
  registerPortfolio(app);
  registerBudgets(app);
  registerCapacity(app);
  registerRaid(app);
  registerCalendar(app); // public: /feeds/calendar/<token>.ics
  registerSlackCommands(app); // public: /slack/commands, /slack/interactivity (Slack-signed requests only)
  app.all('/mcp', (c) => handleMcp(c, app));

  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));
  return app;
}
