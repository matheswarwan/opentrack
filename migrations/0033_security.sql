-- Security: two-factor sign-in (TOTP), recovery codes, the second sign-in step, and session last-seen times.
-- users.totp_secret: base32 secret (set while setting up; active once totp_enabled_at is set). Stored as is:
--   there is no server-side encryption key in this code base. Never in backups (server/lib/backup.js NEVER).
-- users.totp_last_step: the last accepted 30 s time step, so a code cannot be used twice.
ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_enabled_at TEXT;
ALTER TABLE users ADD COLUMN totp_last_step INTEGER;

-- One-time recovery codes: only hashes are stored.
CREATE TABLE recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX idx_recovery_codes_user ON recovery_codes(user_id);

-- The password was right and a code is still needed: a random token (stored hashed), valid 5 minutes.
CREATE TABLE login_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_login_challenges_user ON login_challenges(user_id);

-- Sessions: when the session was last used (written at most every 5 minutes), for Profile > Sessions and the idle timeout.
ALTER TABLE sessions ADD COLUMN last_seen_at TEXT;
