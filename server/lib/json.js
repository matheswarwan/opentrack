// Reading JSON text stored in the database: a bad or empty value never throws, the caller says what it gets instead.

/** The parsed value, or `fallback` when the text is empty, unreadable or the JSON value null. */
export function parseJson(text, fallback = null) {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text) ?? fallback;
  } catch {
    return fallback;
  }
}

/** A stored JSON array; [] for anything else. */
export function parseList(text) {
  const v = parseJson(text, null);
  return Array.isArray(v) ? v : [];
}

/** A stored JSON object (not an array); {} for anything else. */
export function parseObject(text) {
  const v = parseJson(text, null);
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}
