-- Components and releases (fix versions) per project (server/lib/releases.js, server/routes/releases.js).
-- Components: project admins manage them in Project settings > Components. An issue gets the default assignee of a
-- component when it gets that component and has no assignee.
CREATE TABLE components (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  lead_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  default_assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_components_project ON components(project_id);

CREATE TABLE issue_components (
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  component_id TEXT NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  PRIMARY KEY (issue_id, component_id)
);
CREATE INDEX idx_issue_components_component ON issue_components(component_id);

-- Releases (Jira's versions). status: unreleased, released, archived. Dates are YYYY-MM-DD; released_at is the time
-- the Release action ran.
CREATE TABLE releases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  start_date TEXT,
  release_date TEXT,
  status TEXT NOT NULL DEFAULT 'unreleased',
  released_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_releases_project ON releases(project_id, status);

-- Fix versions of an issue.
CREATE TABLE issue_releases (
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  PRIMARY KEY (issue_id, release_id)
);
CREATE INDEX idx_issue_releases_release ON issue_releases(release_id);

-- Default components of an issue template: JSON list of component ids.
ALTER TABLE issue_templates ADD COLUMN components TEXT NOT NULL DEFAULT '[]';
