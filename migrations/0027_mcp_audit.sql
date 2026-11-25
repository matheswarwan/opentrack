-- MCP audit log: what each AI assistant call touched, and which changes came through MCP.
ALTER TABLE mcp_calls ADD COLUMN args TEXT;
ALTER TABLE mcp_calls ADD COLUMN issue_keys TEXT;
ALTER TABLE mcp_calls ADD COLUMN project_key TEXT;
ALTER TABLE mcp_calls ADD COLUMN is_write INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mcp_calls ADD COLUMN duration_ms INTEGER;
ALTER TABLE issue_history ADD COLUMN source TEXT;
ALTER TABLE comments ADD COLUMN source TEXT;
ALTER TABLE worklogs ADD COLUMN source TEXT;
CREATE INDEX idx_mcp_calls_tool ON mcp_calls(tool, created_at);
CREATE INDEX idx_mcp_calls_project ON mcp_calls(project_key, created_at);
