-- Custom fields per project (Project settings > Fields; server/lib/customFields.js).
-- type: text, longtext, number, select, multiselect, date, checkbox, user, url.
-- options: JSON list of {"id","name","archived"} for select and multi-select, in display order. Renaming keeps the id,
-- so stored values keep pointing at the option. Archived options stay readable on issues but cannot be picked.
-- issue_types: JSON list of issue types the field applies to ('[]' = every type).
-- required: 1 = needed when an issue is created (existing issues are not forced).
-- archived: 1 = hidden from forms and payloads; values are kept.
CREATE TABLE custom_fields (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  required INTEGER NOT NULL DEFAULT 0,
  help TEXT,
  issue_types TEXT NOT NULL DEFAULT '[]',
  position INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_custom_fields_project ON custom_fields(project_id, position);

-- One value per issue and field, as normalized text so filtering stays portable:
-- numbers as plain decimal strings, checkboxes '1'/'0', dates YYYY-MM-DD, select an option id, user a user id,
-- multi-select a JSON list of option ids. No row = empty.
CREATE TABLE issue_field_values (
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  field_id TEXT NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  PRIMARY KEY (issue_id, field_id)
);
CREATE INDEX idx_issue_field_values_field ON issue_field_values(field_id);

-- Default field values of an issue template: JSON object {fieldId: value} (API form).
ALTER TABLE issue_templates ADD COLUMN fields TEXT NOT NULL DEFAULT '{}';
