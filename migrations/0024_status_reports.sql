-- Project status reports (server/lib/statusReports.js, server/routes/statusReports.js): a weekly report drafted from
-- tracker data, edited and published by a project admin, optionally shared with the project's guests (the client).
-- period_start, period_end: YYYY-MM-DD (UTC days, both included).
-- rag: JSON { overall, scope, schedule, quality, budget? }, each { suggested, value, reason, why: [..] } (Red/Amber/Green).
-- sections: JSON, the edited content (done, inProgress, next, milestones, risks, decisions, time).
-- data: JSON, a snapshot of the numbers computed when the draft was made.
-- status: draft | published. shared_with_guests: 1 = guest members of the project can read it once published.
CREATE TABLE status_reports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  rag TEXT NOT NULL,
  summary TEXT,
  sections TEXT NOT NULL,
  data TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  published_at TEXT,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  shared_with_guests INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_status_reports_project ON status_reports(project_id, status, period_end);

-- Notifications that are about a project rather than an issue (a published status report): the project and the
-- app path the bell opens. Guests see such a notice only while they can see the project.
ALTER TABLE notifications ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE notifications ADD COLUMN link TEXT;
