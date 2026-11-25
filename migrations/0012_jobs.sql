-- Scheduled jobs (due-date reminders, weekly digest) without a cron trigger: server/lib/jobs.js runs them
-- from ordinary requests or POST /api/admin/jobs/run. Times are local to the timeZone setting.
-- hour: local hour (0-23) it should run; weekday: 0 = Sunday ... 6 = Saturday for weekly jobs, NULL = daily.
-- last_run_on: local date (YYYY-MM-DD) of the last claimed run; claiming sets it with a conditional UPDATE so
-- two requests can never both start the same run.
-- status: running | partial (more people to do; the next trigger continues after `cursor`, a user id) | done | error.
-- result: JSON counts of the last run.
CREATE TABLE jobs (
  name TEXT PRIMARY KEY,
  hour INTEGER NOT NULL DEFAULT 8,
  weekday INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_on TEXT,
  started_at TEXT,
  finished_at TEXT,
  status TEXT,
  cursor TEXT,
  result TEXT,
  error TEXT
);
INSERT INTO jobs (name, hour, weekday, enabled) VALUES ('due_reminders', 8, NULL, 1);
INSERT INTO jobs (name, hour, weekday, enabled) VALUES ('weekly_digest', 8, 1, 1);

-- Per person: due-date reminders and the weekly digest by Slack and by email (1 = on). No row = all on.
-- The in-app notification always comes. The Slack switch for all personal messages (slack_users.dm_enabled) still applies.
CREATE TABLE reminder_prefs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  due_slack INTEGER NOT NULL DEFAULT 1,
  due_email INTEGER NOT NULL DEFAULT 1,
  digest_slack INTEGER NOT NULL DEFAULT 1,
  digest_email INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
