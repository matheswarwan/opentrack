-- Deleted projects go to the Trash (admins): hidden everywhere, restorable for trashDays, then purged.
-- deleted_archived keeps the archived flag from before the delete (a deleted project is archived meanwhile).
ALTER TABLE projects ADD COLUMN deleted_at TEXT;
ALTER TABLE projects ADD COLUMN deleted_by TEXT;
ALTER TABLE projects ADD COLUMN deleted_archived INTEGER;
CREATE INDEX idx_projects_deleted ON projects(deleted_at);
