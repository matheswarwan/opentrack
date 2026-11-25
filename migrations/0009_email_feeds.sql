-- Email notifications and Google Sheets feeds.

-- Per person: which notification types also go out by email (1 = on). No row = the defaults
-- (assigned on, mentioned on, comment off, status off).
CREATE TABLE email_prefs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  on_assigned INTEGER NOT NULL DEFAULT 1,
  on_mentioned INTEGER NOT NULL DEFAULT 1,
  on_comment INTEGER NOT NULL DEFAULT 0,
  on_status INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- Last failed email sends (kept to about 50 rows) so admins can see what went wrong.
CREATE TABLE email_errors (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  error TEXT NOT NULL,
  context TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_email_errors_created ON email_errors(created_at);

-- Secret CSV feed URLs (/feeds/<token>.csv) for Google Sheets IMPORTDATA.
-- query: JSON of /api/issues search parameters; columns: JSON list of column ids.
-- Only the SHA-256 of the token is stored; prefix is its first characters, shown in the list.
-- The feed runs as its owner with the owner's current permissions.
CREATE TABLE feeds (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  columns TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_feeds_owner ON feeds(owner_id);
