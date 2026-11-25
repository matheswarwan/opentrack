-- Capacity planning (server/lib/capacity.js, server/routes/capacity.js).
-- Weekly capacity hours per person; no row = the workspace setting defaultCapacityHours (default 40).
-- Hours per weekday = weekly_hours / 5; Saturdays and Sundays count 0.
CREATE TABLE user_capacity (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  weekly_hours DOUBLE PRECISION NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);

-- Time off: inclusive YYYY-MM-DD date ranges. The note is shown only to the person and workspace admins.
CREATE TABLE time_off (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  note TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_time_off_user ON time_off(user_id, end_date);

-- Share of a person's capacity given to a project, 0 to 100, set by project admins. A separate table (not a
-- project_members column) because changing a member's role re-creates the member row. No row = not allocated:
-- the person's unallocated projects share evenly what their explicit allocations leave (100% with one project).
CREATE TABLE project_allocations (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pct DOUBLE PRECISION NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX idx_project_allocations_user ON project_allocations(user_id);
