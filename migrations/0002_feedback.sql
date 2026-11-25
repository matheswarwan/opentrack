-- In-app feedback (Feedback button in the header). Read by admins under Admin > Feedback.
CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'other',
  message TEXT NOT NULL,
  page TEXT,
  details TEXT,
  screenshot TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  admin_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_feedback_status ON feedback(status, created_at);
CREATE INDEX idx_feedback_user ON feedback(user_id, created_at);
