-- File attachments on issues.
-- storage says where the bytes are: 'db' (file_chunks below, the default), 'r2' (Cloudflare R2
-- binding FILES) or 'gcs' (Google Cloud Storage bucket GCS_BUCKET). R2 and GCS objects are
-- named attachments/<id>.
-- Deleting an issue cascades to its attachments and their chunks; the API deletes R2/GCS objects.
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  comment_id TEXT REFERENCES comments(id) ON DELETE SET NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage TEXT NOT NULL DEFAULT 'db',
  uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_attachments_issue ON attachments(issue_id, created_at);

-- File bytes kept in the database: base64 text in chunks of about 1 MB (D1 rows are at most 2 MB).
CREATE TABLE file_chunks (
  file_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (file_id, seq)
);
