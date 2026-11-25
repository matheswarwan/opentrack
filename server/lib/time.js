// Dates and the clock, in one place.
//
// A "date" here is a calendar day as YYYY-MM-DD text. "Today" for people is the current day in the workspace time
// zone (the timeZone setting), read on the injectable clock (env.now in tests): use today(c) in route handlers.
import { getSettings, DEFAULT_SETTINGS } from './settings.js';

export const DAY = 864e5;
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The current time in ms; tests inject env.now (a number, ISO string or function). */
export function clock(env) {
  const n = env?.now;
  if (typeof n === 'function') return Number(n());
  if (typeof n === 'number') return n;
  if (typeof n === 'string') return new Date(n).getTime();
  return Date.now();
}

export function validTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The workspace time zone of the settings, or the default when it is missing or not a zone name. */
export function workspaceTz(settings) {
  return validTimeZone(settings?.timeZone) ? settings.timeZone : DEFAULT_SETTINGS.timeZone;
}

/** Local date (YYYY-MM-DD), hour (0-23) and weekday (0 = Sunday) of an instant in a time zone. */
export function localParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    weekday: SHORT_DAYS.indexOf(p.weekday),
  };
}

/** The UTC instant (ms) when a local date starts in a time zone. */
export function localMidnight(date, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const offset = (ms) => {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(ms))
      .reduce((o, x) => ({ ...o, [x.type]: Number(x.value) }), {});
    return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - ms;
  };
  let t = guess - offset(guess);
  t = guess - offset(t); // again, in case a DST change falls between
  return t;
}

export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Whole days from date a to date b (negative when b is earlier). */
export function daysBetween(a, b) {
  const t = (s) => Date.UTC(...s.split('-').map((x, i) => Number(x) - (i === 1 ? 1 : 0)));
  return Math.round((t(b) - t(a)) / DAY);
}

/** The Monday (YYYY-MM-DD) of the week a date is in. */
export function mondayOf(date) {
  const d = new Date(`${date}T00:00:00Z`);
  return addDays(date, -((d.getUTCDay() + 6) % 7));
}

/** A real calendar date in YYYY-MM-DD form? (2026-02-31 is not.) */
export function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/**
 * Today (YYYY-MM-DD) in the workspace time zone, on the injectable clock. Sign-in already read the timeZone
 * setting with the session or token (lib/session.js sets `timeZone` on the context), so this costs no query on
 * a signed-in request; elsewhere it reads the settings once per request.
 */
export async function today(c) {
  let tz = c.get('timeZone');
  if (tz === undefined) {
    tz = (await getSettings(c.env.db)).timeZone;
    c.set('timeZone', tz);
  }
  return localParts(clock(c.env), workspaceTz({ timeZone: tz })).date;
}
