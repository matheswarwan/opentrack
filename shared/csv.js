// CSV cell escaping, used by every export on both sides (server/lib/csv.js and src/csv.js re-export it).

/**
 * One CSV cell. null and undefined are empty; numbers are written as they are (a negative number is not a formula).
 * Text that starts with = + - @ (or a tab or carriage return) gets a leading ' so a spreadsheet shows it instead of
 * running it as a formula. Values with a quote, comma or line break are quoted.
 */
export function csvCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One CSV line (no line ending) from a list of values. */
export const csvLine = (cells) => cells.map(csvCell).join(',');

/** Rows (arrays of cells, the header first) as CSV text. */
export const toCsv = (rows) => rows.map(csvLine).join('\n');
