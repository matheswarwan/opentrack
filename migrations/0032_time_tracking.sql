-- Time tracking (server/lib/timeTracking.js, server/routes/timeTracking.js).

-- A running timer: at most one per person (the primary key). Stopping it writes a worklogs row and deletes this row.
-- started_at: ISO time (UTC).
CREATE TABLE timers (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL
);
CREATE INDEX idx_timers_issue ON timers(issue_id);

-- A person's week of work logs sent for approval. week_start: the Monday, week_end: the Sunday (YYYY-MM-DD).
-- status: submitted | approved | rejected. No row: the week was never submitted (or was withdrawn).
-- Approved weeks are locked: work logs dated in them cannot be added, changed or deleted, except by workspace admins.
-- decided_by, decided_at, comment: who approved or rejected it, when, and their comment (cleared on resubmission).
CREATE TABLE timesheet_weeks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start TEXT NOT NULL,
  week_end TEXT NOT NULL,
  status TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at TEXT,
  comment TEXT,
  UNIQUE (user_id, week_start)
);
CREATE INDEX idx_timesheet_weeks_status ON timesheet_weeks(status, week_start);
