-- Roadmap: an optional start date on issues (YYYY-MM-DD, like due_date). The Roadmap draws a bar from
-- start_date to due_date. When both are set, start_date is on or before due_date (checked by the API).
ALTER TABLE issues ADD COLUMN start_date TEXT;
CREATE INDEX idx_issues_start ON issues(start_date);
