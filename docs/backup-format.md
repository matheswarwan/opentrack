# Backup format

A backup is one JSON document, written by `server/lib/backup.js`. The same format is used by:

- Admin > Backups > Download backup (`GET /api/admin/backup`, add `?files=1` for file bytes)
- the daily `backup` job (sent to `BACKUP_WEBHOOK_URL` or `GCS_BACKUP_BUCKET`, gzip compressed, never with file bytes)
- a project export from project settings (`GET /api/projects/<KEY>/export.json`), which holds one project only

`scripts/restore-backup.mjs` loads a full backup into a fresh SQLite or Postgres database.

## Top level

```json
{
  "format": "opentrack-backup",
  "version": 1,
  "schema": "0033_security.sql",
  "createdAt": "2026-11-18T20:00:00.000Z",
  "appName": "Opentrack",
  "includesFiles": false,
  "project": null,
  "tableOrder": ["settings", "users", "projects", "..."],
  "tables": { "settings": [ ... ], "users": [ ... ], "...": [ ... ] },
  "rowCounts": { "settings": 3, "users": 12, "...": 0 },
  "missingFiles": [],
  "complete": true
}
```

| Key | Meaning |
| --- | --- |
| `format`, `version` | Always `opentrack-backup` and `1` for this layout. A later layout gets a new version. |
| `schema` | The last migration the rows match. Columns added by later migrations are missing from older backups. |
| `createdAt` | When the export started (UTC). Rows are read table by table while the file is written, so a change made during the export may or may not be in it. |
| `includesFiles` | `true` when `file_chunks` and `user_avatars` are included. |
| `project` | `null` for a full backup; `{ id, key, name }` for a one-project export. |
| `tableOrder` | The tables in the file, in an order that respects foreign keys (parents first). Restore in this order. |
| `tables` | One array per table: each row is an object of column name to value, exactly as stored. |
| `rowCounts` | Rows written per table. |
| `missingFiles` | Ids of R2/GCS attachments whose bytes could not be read (only with files). |
| `complete` | Written last. A file without it was cut off (for example a download that stopped, or a request that ran out of database queries). |

## Values

Values are as stored in the database: ids are text UUIDs, timestamps are ISO 8601 text in UTC, dates are `YYYY-MM-DD`, booleans are `0` or `1`, and JSON columns (for example `reports.options`, `dashboards.layout`, `issue_templates.labels`, `audit_log.details`, `settings.value`) stay JSON text.

## Tables

Full backup, in order. Columns are all columns of the table unless listed.

| Table | Notes |
| --- | --- |
| `settings` | `key`, `value` (JSON text). Workspace settings such as `appName`, `timeZone`, `trashDays`. |
| `users` | `id, email, name, title, role, status, google_sub, avatar_color, avatar_version, created_at, updated_at, last_login_at, is_system`. No password hash. `is_system` = 1 for the Tracker AI user that writes channel AI notes (it cannot sign in). |
| `user_avatars` | Only with files: `user_id, image` (a data URL), `updated_at`. |
| `projects`, `project_members`, `statuses`, `sprints` | All columns. `projects.perm_delete`, `perm_sprints`, `perm_create`, `perm_comment` are the project permissions; `projects.workflow` holds the workflow rules (JSON: allowed moves, required values and automations per status id, or null); `project_members.role` may be a guest level (`guest-view`, `guest-comment`, `guest-edit`). |
| `issues` | All columns, including issues in the Trash: `deleted_at` (when it was deleted), `deleted_by`, `deleted_with` (a sub-task deleted with its parent has the parent's id). `parent_id` may point to an issue later in the array. |
| `issue_labels`, `comments`, `issue_history`, `issue_links`, `watchers`, `worklogs` | All columns. `comments.internal` = 1 for internal notes (hidden from guests). `comments.parent_id` is the top comment of a thread (may point to a comment later in the array); `comments.deleted_at` is set on a removed comment kept as the "Comment deleted" placeholder of its replies. |
| `comment_reactions` | All columns: `comment_id, user_id, reaction` (a short id such as `thumbsup`), `created_at`. |
| `attachments` | All columns (metadata). `storage` says where the bytes were: `db`, `r2` or `gcs`. `internal` = 1 for files added with an internal note. |
| `file_chunks` | Only with files: `file_id, seq, data` (base64, about 768 KB of bytes per row). Attachments stored in R2 or GCS are read back and written here too, so every file with bytes in the backup is in this table. |
| `issue_templates`, `custom_fields`, `issue_field_values`, `components`, `issue_components`, `releases`, `issue_releases`, `saved_filters`, `reports`, `dashboards` | All columns. |
| `project_templates` | Saved project templates (full backup only): `owner_id`, `visibility` (`private` or `shared`) and `body`, JSON text that names statuses, fields, components and other parts by name. It never holds user ids, comments or history; people appear only as roles (`lead`, `creator`). Built-in templates are part of the code and are not in backups. |
| `board_views`, `board_view_defaults` | Saved board filters (`filters` is JSON text, `shared` = 1 for views shared with the project) and each person's default view per project. |
| `project_channels`, `channel_links`, `ai_suggestions` | Channel AI sessions: Slack channels linked to a project (`kind` internal or external), channel links on issues with the who-is-who `prompt`, session switch and read cursor, and the AI's suggested changes. Slack messages themselves are never stored. |
| `status_reports` | Project status reports: `period_start`, `period_end` (YYYY-MM-DD), `rag`, `sections` and `data` (JSON text: the RAG per area with suggestion and reason, the edited sections, the numbers computed for the draft), `summary`, `status` (`draft` or `published`), `published_at`, `author_id`, `shared_with_guests` (1 = guests of the project can read it once published). |
| `project_budgets`, `budget_lines`, `budget_rates`, `budget_alerts` | Project budgets: `kind` (`hours` or `money`), `amount`, `currency`, optional `start_date` and `end_date`, `thresholds` (JSON list of alert percentages). `budget_lines`: hours budgets per epic or component (`target_type`, `target_id`, `hours`). `budget_rates`: hourly rates with `scope` (`default`, `role` with a project member `role`, or `person` with `user_id`) and `effective_from` (YYYY-MM-DD). `budget_alerts`: the thresholds already announced (`used_pct` at the time). `worklogs.billable` = 1 for billable work (counts against the budget). |
| `user_capacity`, `time_off`, `project_allocations` | Capacity planning: `user_capacity.weekly_hours` per person (no row = the `defaultCapacityHours` setting), `time_off` date ranges (`start_date`, `end_date`, inclusive, YYYY-MM-DD) with an optional `note`, and `project_allocations.pct` (0 to 100) per project and person. |
| `raid_entries`, `raid_links`, `raid_history` | RAID log per project: `number` (shown as RAID-n), `type` (`risk`, `assumption`, `issue`, `decision`), `title`, `description` (Markdown), `owner_id`, `status` (`open`, `monitoring`, `closed`; decisions `proposed`, `agreed`, `superseded`), `review_date` (YYYY-MM-DD), risks: `probability` and `impact` (1 to 5), `score` (their product), `mitigation`, `contingency`; decisions: `decided_by` (a name), `decided_on`, `rationale`. `raid_links`: linked issues (`raid_id`, `issue_id`). `raid_history`: changes (`field`, `old_value`, `new_value`, `actor_id`, `seq` for the order within one change; field `created` for the first row). |
| `timers`, `timesheet_weeks` | Time tracking. `timers`: the running timer of a person (`user_id`, `issue_id`, `started_at`; at most one each). `timesheet_weeks`: weeks submitted for approval: `user_id`, `week_start` (the Monday) and `week_end` (the Sunday, YYYY-MM-DD), `status` (`submitted`, `approved`, `rejected`), `submitted_at`, `decided_by`, `decided_at`, `comment`. Work logs dated in an approved week are locked. Full backup only. |
| `brand_fonts` | Workspace font files uploaded under Admin > Settings > Fonts: `family`, `weight`, `style`, `format` (`woff2`, `woff`, `ttf`, `otf`), `size` and `data` (the file, base64). Full backup only. |
| `project_slack` | Which Slack channel a project posts to, and which events. No token. |
| `slack_users` | `user_id, slack_user_id, looked_up_at, dm_enabled`. |
| `email_prefs`, `reminder_prefs` | Each person's notification choices. |
| `feedback` | Without `screenshot`. |
| `audit_log` | All columns. |

A project export holds only `users` (`id, email, name, role, status` of members, assignees, reporters, component leads and default assignees, and RAID owners), `projects`, `project_members`, `statuses`, `sprints`, `issues`, `issue_labels`, `comments`, `comment_reactions`, `issue_history`, `issue_links` (links touching the project), `watchers`, `worklogs`, `attachments`, `issue_templates`, `custom_fields`, `issue_field_values`, `components`, `issue_components`, `releases`, `issue_releases`, `status_reports`, `project_budgets`, `budget_lines`, `budget_rates`, `budget_alerts`, `project_allocations`, `raid_entries`, `raid_links` and `raid_history`, limited to that project (plus `file_chunks` with `?files=1`).

## Never included

Password hashes, two-factor sign-in (the `users.totp_*` columns, `recovery_codes`, `login_challenges`: after a restore everyone sets two-factor up again), `sessions`, `invites`, `login_failures`, `api_tokens`, OAuth clients, codes and refresh tokens, `feeds` (their token hashes), `integrations` (the Slack token, the Slack signing secret and other integration settings), `webhooks` and `webhook_deliveries` (signing secrets, and URLs that can hold tokens), `notifications`, `jobs`, `backups`, `mcp_calls`, `slack_errors`, `email_errors`, `ai_errors`, and feedback screenshots. AI provider keys live only in the server environment.

## Restoring

```sh
node scripts/restore-backup.mjs tracker-backup-2026-11-18.json --sqlite ./data/restored.db
node scripts/restore-backup.mjs tracker-backup-2026-11-18T02-00-00-000Z.json.gz --postgres postgres://user:pass@host/db

# the copy in GitHub (GITHUB_TOKEN or the gh CLI login), into a fresh Cloudflare D1 database
node scripts/restore-backup.mjs --github owner/tracker-backups --d1-sql restore.sql
npx wrangler d1 migrations apply <db> --remote
npx wrangler d1 execute <db> --remote --file restore.sql
# an older version: name a commit of the backup repository
node scripts/restore-backup.mjs --github owner/tracker-backups@<commit> --sqlite ./data/restored.db
```

### Backup to GitHub

With `GITHUB_BACKUP_REPO` (owner/repo, private) and the secret `GITHUB_BACKUP_TOKEN` (a fine-grained token with Contents read and write on that one repository) set, the `github_backup` job commits the full backup (without file bytes) every 6 hours as `tracker-backup.json` (`GITHUB_BACKUP_PATH`) on `main` (`GITHUB_BACKUP_BRANCH`), one row per line, so the repository's history keeps every version and diffs are readable. Admin > Backups has Back up to GitHub now and lists each run. `--d1-sql` writes INSERT statements for a fresh D1 database (apply its migrations first); it never touches the source.

The script applies the migrations, refuses a database that already has users (unless `--force`), refuses a file without `"complete": true` and one-project exports, then inserts every table in `tableOrder`. Issues are inserted without `parent_id` first and linked afterwards. Attachments whose bytes came along are switched to `storage = 'db'`. People come back without passwords: they sign in with Google, or an admin sets a password or sends a new invite link. Notifications, tokens, feeds, webhooks and the Slack connection must be set up again.

Things a restore does not bring back: anything listed under "Never included", and file bytes when the backup was made without files (the attachment rows remain, the downloads fail).
