-- Slack integration (bot token).
-- integrations: one row per integration; config is JSON. For Slack: token (unless SLACK_BOT_TOKEN is set on the server),
-- enabled, team, botName and who connected it. The token is never sent to the browser.
CREATE TABLE integrations (
  key TEXT PRIMARY KEY,
  config TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Per project: the Slack channel that gets updates and which events post there (JSON list of event names).
CREATE TABLE project_slack (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  channel_name TEXT,
  events TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);

-- Per person: their Slack user (found by email; NULL = looked up, not found) and whether they want Slack DMs.
CREATE TABLE slack_users (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  slack_user_id TEXT,
  looked_up_at TEXT,
  dm_enabled INTEGER NOT NULL DEFAULT 1
);

-- Last failed Slack calls (kept to about 50 rows) so admins can see errors like not_in_channel.
CREATE TABLE slack_errors (
  id TEXT PRIMARY KEY,
  method TEXT NOT NULL,
  error TEXT NOT NULL,
  context TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_slack_errors_created ON slack_errors(created_at);
