// Roadmap timeline arithmetic (components/Roadmap.vue): whole days as UTC day numbers, the zoom levels,
// the range and ticks of the time axis, and what dragging a bar does to an issue's dates. Pure functions.
export const DAY = 864e5;
/** 'YYYY-MM-DD' to a day number (days since 1970-01-01, UTC); null for no date. */
export const dayOf = (iso) => (iso ? Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY) : null);
export const isoOf = (n) => new Date(n * DAY).toISOString().slice(0, 10);
// ppd: pixels per day
export const ZOOMS = { weeks: { ppd: 20, label: 'Weeks' }, months: { ppd: 5, label: 'Months' }, quarters: { ppd: 1.6, label: 'Quarters' } };

/** Start and end day of an issue on the timeline; one date alone is a point. */
export function span(i) {
  const s = dayOf(i.startDate);
  const d = dayOf(i.dueDate);
  if (s === null && d === null) return null;
  return { start: s ?? d, end: d ?? s, point: s === null || d === null };
}

/** The start of the week (Monday), month or quarter that holds the day. */
export function snap(day, zoom) {
  const d = new Date(day * DAY);
  if (zoom === 'weeks') return day - ((d.getUTCDay() + 6) % 7); // Monday
  const m = zoom === 'quarters' ? d.getUTCMonth() - (d.getUTCMonth() % 3) : d.getUTCMonth();
  return Math.round(Date.UTC(d.getUTCFullYear(), m, 1) / DAY);
}
/** The tick after the one that starts on this day. */
export function nextTickDay(day, zoom) {
  if (zoom === 'weeks') return day + 7;
  const d = new Date(day * DAY);
  return Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + (zoom === 'quarters' ? 3 : 1), 1) / DAY);
}

/** The days the time axis covers: every dated issue and today, with room before and (more) after, on whole ticks. */
export function timelineRange(issues, today, zoom) {
  const days = [today];
  for (const i of issues) {
    const s = span(i);
    if (s) days.push(s.start, s.end);
  }
  const pad = zoom === 'weeks' ? 14 : zoom === 'months' ? 31 : 92;
  const start = snap(Math.min(...days) - pad, zoom);
  let end = Math.max(...days) + pad * 2;
  end = nextTickDay(snap(end, zoom), zoom);
  return { start, end };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** The ticks of the axis: { day, x, w, label } with x and w in pixels at ppd pixels per day. */
export function timelineTicks(range, zoom, ppd) {
  const out = [];
  for (let d = range.start; d < range.end; d = nextTickDay(d, zoom)) {
    const dt = new Date(d * DAY);
    const y = dt.getUTCFullYear();
    const m = dt.getUTCMonth();
    const label =
      zoom === 'weeks'
        ? `${MONTHS[m]} ${dt.getUTCDate()}`
        : zoom === 'months'
          ? m === 0 || !out.length
            ? `${MONTHS[m]} ${y}`
            : MONTHS[m]
          : `Q${m / 3 + 1} ${y}`;
    out.push({ day: d, x: (d - range.start) * ppd, w: (nextTickDay(d, zoom) - d) * ppd, label });
  }
  return out;
}

/**
 * The issue's dates after its bar was dragged by delta days. mode: 'move' (the whole bar), 'start' or 'end'
 * (one end, never past the other). An issue with one date only is a point: any drag shifts that date.
 */
export function draggedDates(issue, mode, delta) {
  const s = span(issue);
  const next = { startDate: issue.startDate, dueDate: issue.dueDate };
  if (s.point) {
    // one date only: moving it shifts that date
    if (issue.startDate) next.startDate = isoOf(s.start + delta);
    if (issue.dueDate) next.dueDate = isoOf(s.end + delta);
  } else if (mode === 'move') {
    next.startDate = isoOf(s.start + delta);
    next.dueDate = isoOf(s.end + delta);
  } else if (mode === 'start') next.startDate = isoOf(Math.min(s.start + delta, s.end));
  else next.dueDate = isoOf(Math.max(s.end + delta, s.start));
  return next;
}
