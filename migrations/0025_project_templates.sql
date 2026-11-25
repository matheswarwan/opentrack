-- Saved project templates (server/lib/projectTemplates.js, server/routes/projectTemplates.js). Built-in templates live
-- in code and are listed alongside these rows; builtin is always 0 here (kept so a listing has one shape).
-- owner_id: the person who saved it. visibility: 'private' (only the owner can use it) or 'shared' (everyone but guests).
-- body: JSON, the template by name (statuses, workflow, fields, components, issue templates, recurring rules,
-- permissions, labels, starter issues with relative dates, first sprint). Never user ids, comments or history.
CREATE TABLE project_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  builtin INTEGER NOT NULL DEFAULT 0,
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_project_templates_owner ON project_templates(owner_id);
