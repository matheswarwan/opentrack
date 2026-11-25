-- RAID log (server/lib/raid.js, server/routes/raid.js): risks, assumptions, issues and decisions per project.
-- number: per project (shown as RAID-<number>). type: risk | assumption | issue | decision.
-- status: open | monitoring | closed (risks, assumptions, issues); proposed | agreed | superseded (decisions).
-- review_date: YYYY-MM-DD, the due or review date (the owner gets a reminder with the due-date reminders).
-- Risks: probability and impact 1 to 5, score = probability x impact (stored for sorting), mitigation, contingency.
-- Decisions: decided_by (a name, may be someone outside the workspace), decided_on (YYYY-MM-DD), rationale.
-- Guests never see RAID entries.
CREATE TABLE raid_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  review_date TEXT,
  probability INTEGER,
  impact INTEGER,
  score INTEGER,
  mitigation TEXT,
  contingency TEXT,
  decided_by TEXT,
  decided_on TEXT,
  rationale TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, number)
);
CREATE INDEX idx_raid_entries_project ON raid_entries(project_id, type, status);
CREATE INDEX idx_raid_entries_owner ON raid_entries(owner_id, review_date);

-- Issues an entry is linked to (same project only).
CREATE TABLE raid_links (
  raid_id TEXT NOT NULL REFERENCES raid_entries(id) ON DELETE CASCADE,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (raid_id, issue_id)
);
CREATE INDEX idx_raid_links_issue ON raid_links(issue_id);

-- Change history of an entry: field 'created', or the field changed with old and new values (text, cut to 2000 characters).
-- seq: the order of the rows written by one change (same created_at).
CREATE TABLE raid_history (
  id TEXT PRIMARY KEY,
  raid_id TEXT NOT NULL REFERENCES raid_entries(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  created_at TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_raid_history_entry ON raid_history(raid_id, created_at, seq);
