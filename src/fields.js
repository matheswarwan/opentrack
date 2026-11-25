// Custom fields in the web app (server rules: server/lib/customFields.js).
// Issue payloads hold display values (options as { id, name }, people as { id, name, ... }); the API takes API values
// (option ids, lists of ids, user ids, booleans, numbers, text).

export const FIELD_TYPES = [
  { id: 'text', label: 'Text' },
  { id: 'longtext', label: 'Long text' },
  { id: 'number', label: 'Number' },
  { id: 'select', label: 'Select (one option)' },
  { id: 'multiselect', label: 'Multi-select' },
  { id: 'date', label: 'Date' },
  { id: 'checkbox', label: 'Checkbox' },
  { id: 'user', label: 'Person' },
  { id: 'url', label: 'Link (URL)' },
];
export const fieldTypeLabel = (id) => FIELD_TYPES.find((t) => t.id === id)?.label || id;
export const GROUPABLE = ['select', 'multiselect', 'user', 'checkbox'];

export const activeFields = (fields) => (fields || []).filter((f) => !f.archived);
export const appliesTo = (f, type) => !f.issueTypes?.length || f.issueTypes.includes(type);

/** Display value from a payload -> API value for an edit. */
export function toApi(field, v) {
  if (v === null || v === undefined) return field.type === 'multiselect' ? [] : null;
  if (field.type === 'select' || field.type === 'user') return v.id ?? v;
  if (field.type === 'multiselect') return v.map((o) => o.id ?? o);
  return v;
}

/** Display value -> short text. */
export function fieldText(field, v) {
  if (v === null || v === undefined || (Array.isArray(v) && !v.length)) return '';
  if (field.type === 'checkbox') return v ? 'Yes' : 'No';
  if (field.type === 'select' || field.type === 'user') return v.name || '';
  if (field.type === 'multiselect') return v.map((o) => o.name).join(', ');
  return String(v);
}

/** History rows of custom fields are 'field:<name>'. */
export const historyField = (field) => (String(field || '').startsWith('field:') ? String(field).slice(6) : null);
