-- Project budgets, rates and burn tracking (server/lib/budgets.js, server/routes/budgets.js).
-- One budget per project: kind hours (amount = hours) or money (amount in currency, cost = billable hours x rate).
-- start_date, end_date: optional YYYY-MM-DD; only work logged on those days counts. thresholds: JSON list of
-- percents (default [80, 100]); project admins get one notification per threshold crossed.
CREATE TABLE project_budgets (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CAD',
  start_date TEXT,
  end_date TEXT,
  thresholds TEXT NOT NULL DEFAULT '[80,100]',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Hours budgets for one epic or component of the project (target_type epic | component).
CREATE TABLE budget_lines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  hours DOUBLE PRECISION NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_budget_lines_project ON budget_lines(project_id);

-- Hourly rates. scope default | role (role = a project member role) | person (user_id). A rate applies to work
-- logged on or after effective_from until a newer rate of the same scope starts. Person beats role beats default.
CREATE TABLE budget_rates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  role TEXT,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  rate DOUBLE PRECISION NOT NULL,
  effective_from TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_budget_rates_project ON budget_rates(project_id, effective_from);

-- Thresholds already announced (one notification per project and threshold; cleared when the budget amount or kind changes).
CREATE TABLE budget_alerts (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  threshold INTEGER NOT NULL,
  used_pct DOUBLE PRECISION NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, threshold)
);

-- Billable work (1, the default) counts against the budget; non-billable work is shown apart.
ALTER TABLE worklogs ADD COLUMN billable INTEGER NOT NULL DEFAULT 1;
