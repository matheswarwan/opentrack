# Opentrack

A self-hosted, open-source alternative to Jira: projects, issues, a kanban board, backlog and sprints, roadmaps, reports, time tracking, budgets, capacity planning, status reports, Slack and email notifications, and an MCP server so AI assistants (Claude, ChatGPT, Copilot, Cursor) can work with your issues.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/matheswarwan/opentrack)
[![Run on Google Cloud](https://deploy.cloud.run/button.svg)](https://deploy.cloud.run/?git_repo=https://github.com/matheswarwan/opentrack)

It runs in two places from the same code:

- **Cloudflare Workers + D1**: `server/worker.js`, `wrangler.toml`. Fits in the free plan for small teams.
- **Node + Postgres** (for example Google Cloud Run + Cloud SQL): `server/node.js` with `DATABASE_URL`. Without `DATABASE_URL` it uses a local SQLite file, which is also how local development works.

The API is a Hono app (`server/app.js`). SQL is written to run unchanged on SQLite and Postgres (`migrations/`, adapters in `server/db/adapters.js`). The web app is Vue 3 with Tailwind (`src/`).

## Deploy

### One click on Cloudflare

1. Click **Deploy to Cloudflare** above and sign in to Cloudflare.
2. Cloudflare copies the repository to your GitHub or GitLab account, creates the D1 database, and asks for `SETUP_TOKEN` (any long random string, for example from `openssl rand -hex 24`).
3. The build runs `npm run build`, then `npm run deploy`, which applies the database migrations and deploys the Worker.
4. Open the Worker URL, go to `/setup`, enter the `SETUP_TOKEN` and create the first admin.

Pushes to the copied repository deploy again automatically.

### One click on Google Cloud (Cloud Run)

1. Click **Run on Google Cloud** above. Cloud Shell opens, clones the repository and asks for a Google Cloud project and region.
2. It builds the `Dockerfile` and asks for the variables in `app.json`: `SETUP_TOKEN`, an optional `DATABASE_URL`, and `DEMO_MODE`.
3. Open the service URL it prints, go to `/setup` and create the first admin.

Without `DATABASE_URL` the data lives in SQLite inside the container and is lost when the container restarts, which is fine for a trial only. For real use create a Cloud SQL for PostgreSQL database and set `DATABASE_URL` (`gcloud run services update opentrack --set-env-vars DATABASE_URL=...`); migrations run on start. `app.json` sets one instance at most, which SQLite needs; with Postgres you can raise it.

### By hand

Cloudflare:

```sh
npm install
npx wrangler login
npx wrangler d1 create opentrack          # put the database_id it prints in wrangler.toml
npx wrangler secret put SETUP_TOKEN
npm run deploy:cf                         # build, apply migrations, deploy
```

Any container host: `docker build -t opentrack . && docker run -p 8080:8080 -e SETUP_TOKEN=... -e DATABASE_URL=... opentrack`.

### Public demo mode

Set `DEMO_MODE=true` (a variable in `wrangler.toml` or the Cloudflare dashboard, or an environment variable on Node) to put **Explore the demo** on the sign-in page. Visitors share one demo account that can use every feature and can open every admin page, but cannot change admin settings, its own profile, password, two-factor or sessions, or outgoing webhooks (`server/lib/demo.js`). Create your own admin at `/setup` first: the demo stays off until one exists.

## Sign-in and user provisioning

- The first admin is created at `/setup` with the `SETUP_TOKEN` secret (works only while there are no users).
- Admins add people under Admin > Users, one at a time or from a CSV. Each new user gets an invite link (valid 7 days) to set a password, or the admin sets a password directly. Admins can change roles (admin, member, viewer), deactivate people (signs them out at once) and create a new link to reset a password. Every change is in the audit log.
- Google sign-in turns on when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set. Settings decide which domains may sign in, whether unknown people from those domains get an account on first sign-in, and whether password sign-in stays on.

## Security: two-factor sign-in, allowed domains, sessions

Migration `0033_security.sql`. Code: `server/lib/twofactor.js`, `server/routes/security.js`, `server/lib/session.js`; tests `test/twofactor.test.js`, `test/domains.test.js`, `test/sessions.test.js`.

- **Two-factor sign-in (TOTP).** Under Profile a person turns it on: the server makes a secret, the page shows it as a QR code (drawn in the browser by `src/qr.js`, nothing is loaded from elsewhere) and as text, and a 6-digit code confirms it. Ten one-time recovery codes are shown once; only their hashes are stored. Codes follow RFC 6238 (HMAC-SHA1 with Web Crypto, 30 second steps, one step of drift either way) and each code works once.
- **Signing in.** `POST /api/auth/login` with a right password answers `{ twoFactor: true, pendingToken }` and creates no session. `POST /api/auth/login/2fa` with `{ pendingToken, code }` (a code or a recovery code) starts it. The pending token is random, stored hashed (`login_challenges`) and valid 5 minutes. Wrong codes count toward the same lockout as wrong passwords (10 in 15 minutes per account). A password reset link asks for the code too. Google sign-in is not asked: Google does its own two-step verification.
- **Turning it off** needs a current code, a recovery code or the password. Admins can reset a person's two-factor under Admin > Users (audited, signs the person out).
- **Required for admins** (setting `require2faAdmins`, default off): an admin with a password and no two-factor can only call `GET /api/me` and `/api/me/2fa/*` (other requests answer 403 with `code: "two_factor_required"`), and the web app keeps them on Profile.
- **Allowed email domains** (setting `allowedDomains`, a list; empty allows any): adding, inviting and importing people and account creation on first Google sign-in refuse other addresses. Existing people outside the list keep working and Admin > Users marks them.
- **Sessions.** Profile > Sessions lists a person's sessions (signed in, last used, browser) with Sign out for each and Sign out everywhere else. Admin > Users has Sign out everywhere (audited). Changing a password, turning two-factor off or resetting it signs out the person's other sessions. `sessions.last_seen_at` is written at most every 5 minutes per session.
- **Idle timeout** (setting `idleTimeoutMinutes`, 0 = off, else 15 to 10080): a session not used for that long is refused and removed, between the timeout and 5 minutes after it. The notification bell's timer sends `X-Background: 1` and does not count as use.
- The TOTP secret is stored as is (the code base has no server-side encryption key). The secret, recovery code hashes and pending sign-ins are never in a backup; after a restore everyone sets two-factor up again.

## Email and Google Sheets feeds

- Email turns on when `POSTMARK_SERVER_TOKEN` and `EMAIL_FROM` (for example `Opentrack <tracker@example.com>`) are set; `POSTMARK_STREAM` defaults to `outbound`. Notifications for assignments and mentions are emailed by default, comments and status changes on watched issues when people turn them on under Profile > Notifications. Admins can email invite and reset links and send a test email under Admin > Settings. Failed sends are listed there; they never fail the change that caused them. The provider is one function, `sendEmail` in `server/lib/email.js`.
- Google Sheets feeds: on the Issues page, Google Sheets feed creates a secret CSV link (`/feeds/<token>.csv`) for `=IMPORTDATA(...)`. It runs as its owner with the owner's current access, up to 5,000 rows. Only a hash of the token is stored. Revoked feeds, deactivated owners and Admin > Settings with feeds off give 404.

## Scheduled jobs: due-date reminders and the weekly digest

- Due-date reminders (daily, 08:00) send each person one message for their open issues that are overdue or due today or tomorrow. The weekly digest (Mondays, 08:00) covers their open issues by status, what is due this week, overdue work, issues they watch that others changed in the last 7 days, and their mentions; `/digest` shows the same page any time. Both go to the bell, and by Slack and email when configured (each person can turn those off under Profile). Only projects the person can see are included.
- There is no cron trigger (so it works on accounts without free cron slots). `server/lib/jobs.js` runs jobs from ordinary signed-in requests: after the response, at most once a minute per isolate, it checks the `jobs` table and runs one slice of a due job in the background (`waitUntil`). Times are local to Admin > Settings > Scheduled jobs > time zone (default America/Vancouver). A run is claimed with one conditional `UPDATE ... WHERE last_run_on < ?`, so two requests never both start it, and each person gets at most one reminder and one digest a day.
- With no traffic after the set time, nothing runs. For exact timing, point an external scheduler (Cloud Scheduler, GitHub Actions) at `POST /api/admin/jobs/run` with `Authorization: Bearer <JOBS_SECRET>` (16 characters or more); `GET /api/admin/jobs` shows the last run, result and next time. `JOBS_AUTO=off` turns off request-triggered runs.
- D1 on the free plan allows about 50 queries per request, so a slice stops when its budget runs low (`JOBS_MAX_QUERIES`, default 35; `JOBS_MAX_FETCHES`, default 30; people loaded `JOBS_BATCH` = 20 at a time), saves where it stopped, and the next trigger continues. With Slack and email on, a slice covers about 4 people who have something to send; people with nothing cost one query. On Postgres the defaults are high enough to finish in one go.

## Channel AI sessions

- Project admins link Slack channels to a project (Project settings > Channels), each marked internal or external (shared with the client). On an issue, people who can edit it link one of those channels, or one thread (a pasted message link), with a "who is who" prompt. Migration `0022_channel_ai.sql`; code in `server/lib/channelAi.js`, `server/lib/ai.js`, `server/routes/channelAi.js`.
- A project admin turns the AI session on per link. The `channel_ai` job (every 30 minutes, a few links per slice) reads messages after the link's cursor (`conversations.history`, or `conversations.replies` for a thread; bots and join notices skipped), sends the issue, the prompt, the internal/external flag and the messages to the AI, posts the summary as an internal comment by the "Tracker AI" system user (`users.is_system = 1`: no password, no Google link, hidden from pickers, never assignable) and stores suggested changes. People apply them through the normal issue update (history, notifications) or dismiss them. Low-risk kinds (note, sub-task) can be applied automatically when the PM allows it. Nothing is posted to Slack. Slack messages are not stored and never logged.
- Admin > Settings: `channelAi` (off by default) and `channelAiExternal` (off by default; client messages go to the provider when on). Errors are in Admin > Settings (`ai_errors`, status codes only).
- Provider, from the server environment: `AI_PROVIDER=vertex` with `VERTEX_AI_PROJECT_ID`, `VERTEX_AI_LOCATION` (default `global`) and `VERTEX_AI_CREDENTIALS_JSON` (service account key; the token comes from a signed JWT, cached until it expires); `AI_PROVIDER=gemini` with `GEMINI_API_KEY`; or `AI_PROVIDER=anthropic` with `ANTHROPIC_API_KEY`. `AI_MODEL` overrides the model (default `gemini-flash-latest`, or `claude-sonnet-5-5` for anthropic). Optional: `AI_TIMEOUT_MS` (45000), `AI_MAX_INPUT_CHARS` (30000 characters of messages per run). Without a provider the feature says "AI is not configured" and does nothing.

## Status reports

- Project > Status: project admins draft a client status report from the tracker (default the last 7 days): done in the period by epic, in progress, planned next, releases, risks and blockers, hours logged, and a suggested RAG for Scope, Schedule, Quality and Budget (hours against estimates) with an Overall. They edit it, publish it (in-app notice to project members) and can share it with the project's guests. Published reports are read only until unpublished. Copy as text gives Markdown; Download opens a print page (`/projects/<KEY>/status/<id>/print`) to save as PDF. Draft with AI uses the channel AI provider when AI is configured and `channelAi` is on. `GET /api/status-summary` returns the latest published RAG per visible project. Migration `0024_status_reports.sql`; code in `server/lib/statusReports.js`, `server/routes/statusReports.js`.

## Portfolio

- `/portfolio` (sidebar): every visible project with its health (latest published status report RAG, else a computed RAG from the same rules, labelled computed), % done by issues and points, open, overdue, blocked, high priority bugs, next release, active sprint, budget % used (when the budgets tables exist; never for guests) and last activity. Summary tiles, a 90-day Milestones strip, filters and sort in the URL, CSV export. `GET /api/portfolio?archived=1` aggregates with GROUP BY in 8 statements whatever the project count (`test/portfolio.test.js`). Code in `server/lib/portfolio.js` (`budgetSummaries` returns `{}` without the budgets tables), `server/routes/portfolio.js`, `src/portfolio.js`, `src/views/PortfolioPage.vue`.
## Budgets

- Project settings > Budget (project admins, migration 0026, `server/lib/budgets.js`, `server/routes/budgets.js`): hours or money (default CAD), optional start and end dates, alert thresholds (default 80% and 100%), optional hours budgets per epic or component, and hourly rates (project default, per project member role, per person) with an effective-from date. Cost = billable hours x the rate in effect on the work date (person, then role, then default).
- Work logs are billable by default (`worklogs.billable`); a checkbox when logging work, bulk marking in the Timesheet (own entries; admins anyone's), `PATCH /api/worklogs/:id` for the author or a project admin.
- Reports tab > Budget: burn-up (budget, cumulative actual, forecast), tiles, per-epic and per-person tables, forecast from remaining estimates and the last 4 weeks' burn. Money only for project and workspace admins; members see hours and percentages; guests get a 404.
- Project admins get one in-app notification per threshold crossed (checked when work is logged, billable changes, or the budget or rates are saved; a new amount or type starts them again). Status reports use the budget for the Budget RAG when there is one (percentages only). CSV of billable hours and cost by person and week: `GET /api/projects/:key/budget/export.csv?from&to`.

## Time tracking: timer and timesheet approval

- Timer (migration 0032, `server/lib/timeTracking.js`, `server/routes/timeTracking.js`): Start timer on an issue (people who can log work on it), one running timer per person (`timers`), shown in the header on every page with Stop and Discard. Stop writes a work log for the elapsed time rounded up to the minute, with an optional note; starting another timer stops and logs the first; a timer over 12 hours needs the hours confirmed. API: `GET /api/me/timer`, `POST /api/me/timer/start { issueKey }`, `POST /api/me/timer/stop { note, hours, workDate, billable }`, `DELETE /api/me/timer`.
- Weekly approval (`timesheet_weeks`): Submit week on the Timesheet (Monday to Sunday), withdraw while it waits. Approvers are workspace admins and the leads of projects the person logged time on that week; they approve or reject (with a comment) under Timesheet > Approvals (`/timesheet/approvals`), which lists the hours per project. The submitter gets a notification; submit, withdraw, approve and reject are in the audit log.
- Approved weeks are locked: creating, changing or deleting work logs dated in them answers 400 for everyone except workspace admins. A rejected week can be changed and resubmitted; an admin can reopen an approved week by rejecting it. API: `POST /api/timesheet/weeks { week }`, `DELETE /api/timesheet/weeks/:id`, `POST /api/timesheet/weeks/:id/approve|reject { comment }`, `GET /api/timesheet/approvals`.

## Capacity planning

- `/capacity` (sidebar, not for guests; migration 0028, `server/lib/capacity.js`, `server/routes/capacity.js`): people x the next 8 weeks, booked / available hours per cell with the percentage and a level word (Light under 70%, Good 70 to 100%, Over above 100%, Overloaded above 120%), time-off weeks marked Away, an Unscheduled column, a list of issues per cell and a CSV export (`GET /api/capacity/export.csv`).
- Available: weekly hours per person (`user_capacity`; default the `defaultCapacityHours` setting, 40), a fifth per weekday, weekends and time off (`time_off`) count 0. People set their own hours and time off; admins can set anyone's. Time-off notes go only to the person and admins.
- Booked: open, non-epic issues assigned to the person, remaining = max(estimate - logged, 0), spread over the weekdays from the start date (or today) to the due date, else from today to the end of the issue's sprint (active or future, when it has an end date), else unscheduled. Overdue work counts today.
- Filters: `project` (only that project's work, and available hours times the person's allocation) and `team` (only that project's members; defaults to `project`). Allocations (`project_allocations`, 0 to 100%) are set by project admins in Project settings > Capacity. Without one, a person's unallocated projects share evenly what their explicit allocations leave (100% with one project).
- Members see people who share a project with them; hours on projects they cannot see are counted but not named. Guests get 404. The grid uses 4 grouped queries per 80 people (about 11 statements for 90 people).
- Backlog: each sprint with dates shows the team's available hours (from today for the active sprint) against its estimated remaining (`GET /api/projects/:key/sprint-capacity`).

## Trash and backups

- Deleting an issue (single or bulk) moves it and its sub-tasks to the Trash (`issues.deleted_at`, migration 0013); every list, search, report, feed and job leaves it out. The reporter (while they can still edit the project) or a project admin restores it from `/trash`; restoring brings back the sub-tasks deleted with it, and a story whose epic is gone comes back without a parent. Project admins can delete forever. The daily `trash_purge` job removes items older than the `trashDays` setting (default 30) with the old hard-delete path (rows, database chunks, R2/GCS objects). Keys are never reused.
- Admin > Backups downloads a full JSON backup, streamed table by table (`server/lib/backup.js`; format in `docs/backup-format.md`), optionally with file bytes when attachments total at most 50 MB (`BACKUP_FILES_MAX`). It never includes password hashes, sessions, token hashes, the Slack token or other integration settings. Project admins can export one project as CSV or JSON from project settings.
- The daily `backup` job sends the same JSON (gzip, without file bytes) to `BACKUP_WEBHOOK_URL` (with `BACKUP_WEBHOOK_SECRET` as the `X-Backup-Secret` header) or, if that is not set, to `GCS_BACKUP_BUCKET` (same sign-in as `GCS_BUCKET`). Without either it does nothing. Results are listed under Admin > Backups.
- Backup to GitHub: set `GITHUB_BACKUP_REPO` (owner/repo, private) and the secret `GITHUB_BACKUP_TOKEN` (fine-grained token, Contents read and write on that repository only); the `github_backup` job commits the full backup every 6 hours (optional `GITHUB_BACKUP_BRANCH`, `GITHUB_BACKUP_PATH`). Restore with `scripts/restore-backup.mjs --github owner/repo` (`--d1-sql` for a fresh D1). See docs/backup-format.md.
- Deleting a project (admins, Project settings > Delete project): it goes to the Trash (hidden everywhere, restorable) and is removed for good after the Trash period or with Delete forever.
- `node scripts/restore-backup.mjs backup.json[.gz] --sqlite new.db` (or `--postgres <url>`) loads a backup into a fresh database. People come back without passwords.
- On D1's free plan one request allows about 50 queries. A backup reads a few hundred rows per query, which is fine for small and medium workspaces, but a very large workspace could run out part way; the file then lacks `"complete": true`.

## Development

```sh
npm install
npm test                    # API tests (node:sqlite in memory)
SETUP_TOKEN=dev npm run dev:api   # API on http://127.0.0.1:8787 (SQLite in ./data)
npm run dev                 # front end on http://localhost:5173, proxies /api to 8787
```

Requires Node 22.13 or later (built-in `node:sqlite`).

## Attachments

Issues take file attachments (Add attachment, drag and drop onto an issue, or paste an image into a description or comment). Where the bytes go depends on the host:

- Default: the database itself (`file_chunks`, base64 in chunks of about 1 MB). Up to 10 MB per file.
- Cloudflare R2: add an R2 bucket binding named `FILES` to `wrangler.toml`. Up to 25 MB per file.
- Google Cloud Storage: set `GCS_BUCKET` (and `GCS_SERVICE_ACCOUNT` with a key as JSON, or let Cloud Run's own service account sign in through the metadata server). Up to 25 MB per file.

At most 50 files per issue. Each file remembers where it was stored, so changing the backend later does not break older files. Pictures (PNG, JPEG, GIF, WebP) and PDFs open in the browser; everything else downloads, and HTML, SVG, scripts and programs are always served as plain downloads.

## License

MIT. See `LICENSE`.
