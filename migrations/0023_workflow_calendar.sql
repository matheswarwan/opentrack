-- Workflow rules per project (server/lib/workflow.js): allowed status moves, values required when entering a status,
-- and automations on entering a status. JSON text, validated on write (PUT /api/projects/:key/workflow).
-- NULL = no rules: any status to any, nothing required, no automations.
ALTER TABLE projects ADD COLUMN workflow TEXT;

-- Feeds: kind 'csv' (Google Sheets, /feeds/<token>.csv) or 'ics' (calendar subscription, /feeds/calendar/<token>.ics,
-- server/routes/calendar.js). Calendar feeds keep their filters in query and an empty columns list.
ALTER TABLE feeds ADD COLUMN kind TEXT NOT NULL DEFAULT 'csv';
