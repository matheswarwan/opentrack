// Calendar-day helpers for the client. Days are 'YYYY-MM-DD' strings. "Today" is always the
// user's local calendar day (never the UTC day, which is already tomorrow in the evening west
// of Greenwich). Arithmetic on day strings is done in UTC so daylight saving never shifts a day.

const DAY = 864e5;

export const pad = (n) => String(n).padStart(2, '0');

/** Local calendar day of a Date as YYYY-MM-DD. */
export const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Today's local calendar day. `now` is for tests. */
export const today = (now = new Date()) => localIso(now);

const utc = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));

/** addDays('2026-11-30', 1) -> '2026-12-01' */
export const addDays = (iso, n) => new Date(utc(iso) + n * DAY).toISOString().slice(0, 10);

/** Whole days from a to b: dayDiff('2026-11-20', '2026-11-23') -> 3 */
export const dayDiff = (a, b) => Math.round((utc(b) - utc(a)) / DAY);

/** The Monday of the week that holds the day. */
export const mondayOf = (iso) => addDays(iso, -((new Date(utc(iso)).getUTCDay() + 6) % 7));

/** Hours as text, rounded: fmtHours(1.256) -> '1.26', fmtHours(7.5, 1) -> '7.5', fmtHours(null) -> '0' */
export function fmtHours(h, digits = 2) {
  const k = 10 ** digits;
  return (Math.round((Number(h) || 0) * k) / k).toString();
}
