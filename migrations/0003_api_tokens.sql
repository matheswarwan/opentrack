-- Personal API tokens (for the MCP server and scripts). Only the SHA-256 of a token is stored.
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT
);
CREATE INDEX idx_api_tokens_user ON api_tokens(user_id);
