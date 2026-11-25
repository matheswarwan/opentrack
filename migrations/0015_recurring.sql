-- Recurring issues: per project rules that create an issue on a schedule (server/lib/recurring.js).
-- The daily `recurring` job (server/lib/jobs.js) creates due occurrences; dates are local to the timeZone setting.
-- title: may hold the tokens {date}, {month}, {year} and {week}.
-- labels, subtasks: JSON lists of strings. template_id: optional issue template (its prefix, description,
-- labels and sub-tasks are added). sprint: 'backlog' or 'active' (the active sprint when there is one).
-- due_days: due date this many days after the occurrence date (NULL = no due date).
-- schedule: JSON, e.g. {"freq":"weekly","weekdays":[1,4]}; see recurring.js for every form.
-- start_date / end_date: local dates (end optional). max_count: stop after this many issues (optional).
-- created_count: issues created so far. paused: 1 = skipped by the job.
CREATE TABLE recurring_rules (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'task',
  description TEXT,
  priority TEXT NOT NULL DEFAULT 'medium',
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  labels TEXT NOT NULL DEFAULT '[]',
  template_id TEXT REFERENCES issue_templates(id) ON DELETE SET NULL,
  subtasks TEXT NOT NULL DEFAULT '[]',
  sprint TEXT NOT NULL DEFAULT 'backlog',
  due_days INTEGER,
  schedule TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT,
  max_count INTEGER,
  created_count INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0,
  last_created_on TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_recurring_project ON recurring_rules(project_id);

-- One row per created occurrence. The unique (rule_id, occurs_on) pair makes sure a rule never creates
-- two issues for the same date, even when two job runs overlap. issue_id links the issue back to its rule.
CREATE TABLE recurring_occurrences (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES recurring_rules(id) ON DELETE CASCADE,
  occurs_on TEXT NOT NULL,
  issue_id TEXT REFERENCES issues(id) ON DELETE SET NULL,
  issue_key TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (rule_id, occurs_on)
);
CREATE INDEX idx_recurring_occ_issue ON recurring_occurrences(issue_id);

INSERT INTO jobs (name, hour, weekday, enabled) VALUES ('recurring', 6, NULL, 1);
