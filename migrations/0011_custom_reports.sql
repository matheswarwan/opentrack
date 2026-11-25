-- Custom reports and dashboards (Reports page). Reports are saved definitions only: the numbers are
-- always worked out when someone looks, as that person, so a shared report never shows issues the
-- viewer could not see.
-- source: JSON {"filterId": "..."} or {"query": {issue search params}}
-- options: JSON, depends on kind (breakdown, twoD, createdVsResolved, averageAge, workload, list)
-- layout: JSON list of {"reportId": "...", "width": "half" | "full"}, in display order
CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '{}',
  visibility TEXT NOT NULL DEFAULT 'private',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_reports_owner ON reports(owner_id);
CREATE INDEX idx_reports_visibility ON reports(visibility);

CREATE TABLE dashboards (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  layout TEXT NOT NULL DEFAULT '[]',
  visibility TEXT NOT NULL DEFAULT 'private',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_dashboards_owner ON dashboards(owner_id);
