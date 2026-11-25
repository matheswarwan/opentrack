-- Channel AI sessions: Slack channels linked to projects and issues, read by an AI that summarizes new messages and
-- suggests issue changes. Code: server/lib/channelAi.js, server/lib/ai.js, server/routes/channelAi.js.
-- users.is_system: 1 = a system account (the "Tracker AI" author of AI comments). It has no password and no Google
-- link, so it can never sign in; it is left out of people pickers, assignment and reminders.
ALTER TABLE users ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0;

-- Slack channels linked to a project by a project admin. kind: 'internal' (our team) or 'external' (shared with the client).
CREATE TABLE project_channels (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  channel_name TEXT,
  kind TEXT NOT NULL DEFAULT 'internal',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, channel_id)
);

-- A project channel (or one thread in it) linked to an issue, with the "who is who" prompt for the AI.
-- thread_ts: the thread's first message (NULL = the whole channel). session_on: the AI session (project admins switch it).
-- auto_apply: 1 = low-risk suggestions (comment, sub-task) are applied without a click.
-- cursor_ts: the newest Slack message already read (Slack ts text, e.g. 1700000000.000100); NULL = not read yet.
-- last_status: ok | nothing_new | error. last_result: JSON counts of the last run (never message text).
CREATE TABLE channel_links (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  project_channel_id TEXT NOT NULL REFERENCES project_channels(id) ON DELETE CASCADE,
  thread_ts TEXT,
  permalink TEXT,
  prompt TEXT,
  session_on INTEGER NOT NULL DEFAULT 0,
  auto_apply INTEGER NOT NULL DEFAULT 0,
  cursor_ts TEXT,
  last_run_at TEXT,
  last_status TEXT,
  last_result TEXT,
  last_error TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_channel_links_issue ON channel_links(issue_id);
CREATE INDEX idx_channel_links_session ON channel_links(session_on, last_run_at);

-- Changes the AI suggested. kind: status | assignee | dueDate | subtask | comment | priority.
-- value: what people see; target: what Apply uses (status id, user id, YYYY-MM-DD, priority, sub-task title, comment text).
-- status: pending | applied | dismissed. decided_by NULL with status applied = applied automatically.
CREATE TABLE ai_suggestions (
  id TEXT PRIMARY KEY,
  link_id TEXT REFERENCES channel_links(id) ON DELETE SET NULL,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  value TEXT,
  target TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  comment_id TEXT,
  decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ai_suggestions_issue ON ai_suggestions(issue_id, status);

-- Last failed AI provider calls (about 50 rows kept). Never holds prompts or message text.
CREATE TABLE ai_errors (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  error TEXT NOT NULL,
  context TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ai_errors_created ON ai_errors(created_at);
