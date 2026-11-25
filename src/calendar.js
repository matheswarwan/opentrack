// Calendar grid arithmetic (components/Calendar.vue). Dates are local: 'YYYY-MM-DD' strings in the data,
// Date objects for the grid (so addDays and monday here take a Date, unlike src/dates.js). Pure functions.
import { localIso as iso, dayDiff } from './dates.js';

export const parse = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
export const monday = (d) => addDays(d, -((d.getDay() + 6) % 7));

/**
 * Where a bar from start to end (sprints in month view, issue spans in week view) sits in a week
 * { from, to }: its grid-column start / end, clipped to the week. null when it is not in that week.
 */
export function place(week, start, end) {
  if (end < week.from || start > week.to) return null;
  const a = start < week.from ? 0 : dayDiff(week.from, start);
  const b = end > week.to ? 6 : dayDiff(week.from, end);
  return { gridColumn: `${a + 1} / ${b + 2}` };
}

/**
 * The change when an issue is dropped on a day: the day becomes its due date. A start to due span moves as a
 * whole; an issue with only a start date keeps it unless it would be after the new due date.
 */
export function droppedOn(i, day) {
  const shift = i.dueDate ? dayDiff(i.dueDate, day) : 0;
  const change = { dueDate: day };
  if (i.startDate && i.dueDate) change.startDate = iso(addDays(parse(i.startDate), shift));
  else if (i.startDate && i.startDate > day) change.startDate = day;
  return change;
}
