-- OAuth 2.1 sign-in for the MCP server (claude.ai, Claude Desktop, ChatGPT connectors).
-- Access tokens are api_tokens rows with kind = 'oauth'. Codes and refresh tokens are stored as SHA-256 hashes.
CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_secret_hash TEXT,
  client_name TEXT,
  redirect_uris TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE oauth_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  granted_at TEXT NOT NULL
);
CREATE INDEX idx_oauth_refresh_user ON oauth_refresh_tokens(user_id, client_id);

ALTER TABLE api_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE api_tokens ADD COLUMN client_id TEXT;
CREATE INDEX idx_api_tokens_client ON api_tokens(user_id, client_id);
