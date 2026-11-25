-- Issue templates, per project. Project admins manage them under Project settings > Templates.
-- title_prefix: put before the summary (e.g. "[Bug] "), or a pattern with {title} in it.
-- labels and subtasks: JSON lists of strings (sub-task titles are created under the new issue).
CREATE TABLE issue_templates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'task',
  title_prefix TEXT,
  description TEXT,
  priority TEXT,
  labels TEXT NOT NULL DEFAULT '[]',
  subtasks TEXT NOT NULL DEFAULT '[]',
  position INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_issue_templates_project ON issue_templates(project_id, position);
