-- Outgoing webhooks (server/lib/webhooks.js, server/routes/webhooks.js).
-- project_id NULL = workspace-wide (admins); otherwise one project (its project admins).
-- events: JSON list of event names. include_internal: 1 = also send comment.created for internal notes.
-- signing_secret: used to sign each delivery (HMAC-SHA256). Shown once when the webhook is created; never in API
-- answers after that, never in backups (the whole table is left out, like integrations).
-- failure_count: failed deliveries in a row; at 20 the webhook is turned off (active = 0, disabled_reason set).
CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT,
  url TEXT NOT NULL,
  events TEXT NOT NULL,
  include_internal INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  signing_secret TEXT NOT NULL,
  failure_count INTEGER NOT NULL DEFAULT 0,
  disabled_reason TEXT,
  last_delivery_at TEXT,
  last_status INTEGER,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_webhooks_project ON webhooks(project_id, active);

-- The last 50 deliveries per webhook. payload: the first 2 KB of the body only (for display). ref: a small JSON
-- description of the event (ids and changes) used by Redeliver to build the payload again.
CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 0,
  status_code INTEGER,
  duration_ms INTEGER,
  error TEXT,
  payload_size INTEGER NOT NULL DEFAULT 0,
  payload TEXT,
  ref TEXT,
  test INTEGER NOT NULL DEFAULT 0,
  redelivery_of TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_webhook_deliveries_hook ON webhook_deliveries(webhook_id, created_at);
