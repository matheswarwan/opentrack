-- Jira Cloud import (Admin > Import from Jira; server/lib/jiraImport.js). One row per import run.
-- jira_email / jira_token: the Jira account email and API token, kept only while the run needs them.
-- They are set to NULL when the run finishes, fails or is cancelled, and are never sent to the browser.
-- status: connected | planned | running | ready (dry run done) | waiting (Jira rate limit) | done | cancelled | error.
-- mode: dryrun | import. stage: the current stage of the run (see jiraImport.js).
-- plan, options, state, progress, people, dry_run, report: JSON.
-- lease_until: a step holds this while it runs, so two browser tabs never run the same step at once.
-- retry_after: Jira answered 429; steps wait until this time.
CREATE TABLE jira_imports (
  id TEXT PRIMARY KEY,
  site TEXT NOT NULL,
  jira_email TEXT,
  jira_token TEXT,
  jira_user TEXT,
  status TEXT NOT NULL,
  mode TEXT,
  stage TEXT,
  plan TEXT,
  options TEXT,
  state TEXT,
  progress TEXT,
  people TEXT,
  dry_run TEXT,
  report TEXT,
  error TEXT,
  lease_until TEXT,
  retry_after TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_jira_imports_created ON jira_imports(created_at);

-- What each Jira object became, so a repeated step never imports it twice and links and parents resolve.
-- kind: project | status | sprint | issue | link | attachment | parent (an issue waiting for its parent).
-- jira_id: Jira's id (statuses: <project id>:<status id>). local_id: the tracker row id.
-- jira_key / local_key: issue keys (KEY-12). data: JSON for pending work (attachments, parents).
CREATE TABLE jira_import_map (
  import_id TEXT NOT NULL REFERENCES jira_imports(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  jira_id TEXT NOT NULL,
  local_id TEXT,
  jira_key TEXT,
  local_key TEXT,
  data TEXT,
  PRIMARY KEY (import_id, kind, jira_id)
);

-- Problems with single issues, comments or files; the run goes on and lists them in the report.
CREATE TABLE jira_import_errors (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES jira_imports(id) ON DELETE CASCADE,
  stage TEXT,
  jira_key TEXT,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_jira_import_errors ON jira_import_errors(import_id, created_at);
