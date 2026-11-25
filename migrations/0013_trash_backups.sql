-- Trash: deleting an issue moves it (and its sub-tasks) to the Trash instead of removing rows.
-- deleted_at: when it went to the Trash (NULL = not deleted). Every list and read skips deleted issues.
-- deleted_by: who deleted it.
-- deleted_with: for sub-tasks that went to the Trash with their parent, the parent's id, so restoring the
-- parent brings them back. NULL for an issue deleted on its own (it shows as its own Trash item).
-- The daily trash_purge job removes items older than the trashDays setting (default 30) for good.
ALTER TABLE issues ADD COLUMN deleted_at TEXT;
ALTER TABLE issues ADD COLUMN deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE issues ADD COLUMN deleted_with TEXT;
CREATE INDEX idx_issues_deleted ON issues(deleted_at);

-- Backups: one row per full backup (an admin download or the daily automatic copy).
-- kind: download | webhook | gcs. status: running | ok | error. size: bytes sent (compressed when gzip).
-- destination: where it went, without secrets (the webhook host, or gs://bucket/name).
CREATE TABLE backups (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  size INTEGER,
  row_count INTEGER,
  destination TEXT,
  error TEXT,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_backups_started ON backups(started_at);

INSERT INTO jobs (name, hour, weekday, enabled) VALUES ('trash_purge', 3, NULL, 1);
INSERT INTO jobs (name, hour, weekday, enabled) VALUES ('backup', 2, NULL, 1);
