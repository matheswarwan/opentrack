-- Token scopes and revocation, and the MCP activity log.
-- project_scope: NULL = every project the user can see; else a JSON array of project ids.
-- revoked_at: revoked personal tokens stay listed (greyed out) but no longer work.
ALTER TABLE api_tokens ADD COLUMN project_scope TEXT;
ALTER TABLE api_tokens ADD COLUMN revoked_at TEXT;

-- One append-only row per MCP tools/call, and per rejected credential at /mcp.
-- Only the token prefix is stored, never the token. Rows older than 90 days are deleted.
CREATE TABLE mcp_calls (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  token_id TEXT,
  token_prefix TEXT,
  client_name TEXT,
  tool TEXT,
  ok INTEGER NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_mcp_calls_user ON mcp_calls(user_id, created_at);
CREATE INDEX idx_mcp_calls_created ON mcp_calls(created_at);
