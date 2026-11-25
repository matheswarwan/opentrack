// Pure helpers taken out of the Roadmap, Calendar and RAID views: src/roadmap.js, src/calendar.js, src/raid.js.
import { describe, it, expect } from 'vitest';
import { dayOf, isoOf, span, snap, nextTickDay, timelineRange, timelineTicks, draggedDates, ZOOMS } from '../src/roadmap.js';
import { parse, addDays, monday, place, droppedOn } from '../src/calendar.js';
import { localIso } from '../src/dates.js';
import { SORTS, matchesFilter, riskHeat, historyText } from '../src/raid.js';

describe('roadmap days', () => {
  it("dayOf and isoOf are each other's reverse", () => {
    expect(dayOf('1970-01-02')).toBe(1);
    expect(dayOf('')).toBe(null);
    expect(dayOf(null)).toBe(null);
    expect(isoOf(dayOf('2026-11-20'))).toBe('2026-11-20');
    expect(isoOf(dayOf('2024-02-29') + 1)).toBe('2024-03-01');
  });
  it('span: both dates, one date (a point) or none', () => {
    expect(span({ startDate: '2026-11-02', dueDate: '2026-11-06' })).toEqual({
      start: dayOf('2026-11-02'),
      end: dayOf('2026-11-06'),
      point: false,
    });
    expect(span({ startDate: null, dueDate: '2026-11-06' })).toEqual({ start: dayOf('2026-11-06'), end: dayOf('2026-11-06'), point: true });
    expect(span({ startDate: '2026-11-02', dueDate: null }).point).toBe(true);
    expect(span({ startDate: null, dueDate: null })).toBe(null);
  });
  it('snap goes back to the Monday, the first of the month or of the quarter', () => {
    const d = dayOf('2026-11-19'); // a Thursday
    expect(isoOf(snap(d, 'weeks'))).toBe('2026-11-16');
    expect(isoOf(snap(dayOf('2026-11-16'), 'weeks'))).toBe('2026-11-16');
    expect(isoOf(snap(dayOf('2026-11-22'), 'weeks'))).toBe('2026-11-16'); // Sunday
    expect(isoOf(snap(d, 'months'))).toBe('2026-11-01');
    expect(isoOf(snap(d, 'quarters'))).toBe('2026-10-01');
  });
  it('nextTickDay steps a week, a month or a quarter, over a year end too', () => {
    expect(isoOf(nextTickDay(dayOf('2026-11-16'), 'weeks'))).toBe('2026-11-23');
    expect(isoOf(nextTickDay(dayOf('2026-12-01'), 'months'))).toBe('2027-01-01');
    expect(isoOf(nextTickDay(dayOf('2026-10-01'), 'quarters'))).toBe('2027-01-01');
  });
});

describe('roadmap axis', () => {
  const today = dayOf('2026-11-20');
  const issues = [
    { startDate: '2026-11-02', dueDate: '2026-12-18' },
    { startDate: null, dueDate: null },
    { startDate: null, dueDate: '2027-01-15' },
  ];
  it('the range covers every dated issue and today with padding, on whole ticks', () => {
    const r = timelineRange(issues, today, 'months');
    expect(isoOf(r.start)).toBe('2026-10-01'); // 2 Nov less 31 days, snapped to the month
    expect(isoOf(r.end)).toBe('2027-04-01'); // 15 Jan plus 62 days, to the end of that month
    const w = timelineRange([], today, 'weeks');
    expect(isoOf(w.start)).toBe('2026-11-02');
    expect(isoOf(w.end)).toBe('2026-12-21');
  });
  it('ticks fill the range exactly, with the year on the first tick and on January', () => {
    const r = timelineRange(issues, today, 'months');
    const ticks = timelineTicks(r, 'months', ZOOMS.months.ppd);
    expect(ticks.map((t) => t.label)).toEqual(['Oct 2026', 'Nov', 'Dec', 'Jan 2027', 'Feb', 'Mar']);
    expect(ticks[0].x).toBe(0);
    expect(ticks[1].x).toBe(31 * 5);
    expect(ticks[0].w).toBe(31 * 5);
    expect(ticks.reduce((s, t) => s + t.w, 0)).toBe((r.end - r.start) * 5);
  });
  it('week and quarter labels', () => {
    expect(timelineTicks({ start: dayOf('2026-11-16'), end: dayOf('2026-11-30') }, 'weeks', 20).map((t) => t.label)).toEqual([
      'Nov 16',
      'Nov 23',
    ]);
    expect(timelineTicks({ start: dayOf('2026-10-01'), end: dayOf('2027-04-01') }, 'quarters', 1.6).map((t) => t.label)).toEqual([
      'Q4 2026',
      'Q1 2027',
    ]);
  });
});

describe('roadmap drag', () => {
  const bar = { startDate: '2026-11-02', dueDate: '2026-11-06' };
  it('moving shifts both dates', () => {
    expect(draggedDates(bar, 'move', 3)).toEqual({ startDate: '2026-11-05', dueDate: '2026-11-09' });
    expect(draggedDates(bar, 'move', -2)).toEqual({ startDate: '2026-10-31', dueDate: '2026-11-04' });
  });
  it('an end moves alone and stops at the other end', () => {
    expect(draggedDates(bar, 'start', 2)).toEqual({ startDate: '2026-11-04', dueDate: '2026-11-06' });
    expect(draggedDates(bar, 'start', 10)).toEqual({ startDate: '2026-11-06', dueDate: '2026-11-06' });
    expect(draggedDates(bar, 'end', 5)).toEqual({ startDate: '2026-11-02', dueDate: '2026-11-11' });
    expect(draggedDates(bar, 'end', -10)).toEqual({ startDate: '2026-11-02', dueDate: '2026-11-02' });
  });
  it('a point keeps being a point: only the date it has moves', () => {
    expect(draggedDates({ startDate: null, dueDate: '2026-11-06' }, 'move', 2)).toEqual({ startDate: null, dueDate: '2026-11-08' });
    expect(draggedDates({ startDate: '2026-11-02', dueDate: null }, 'end', 2)).toEqual({ startDate: '2026-11-04', dueDate: null });
  });
});

describe('calendar grid', () => {
  it('parse, addDays and monday work on local dates', () => {
    expect(localIso(parse('2026-11-20'))).toBe('2026-11-20');
    expect(localIso(addDays(parse('2026-11-30'), 1))).toBe('2026-12-01');
    expect(localIso(addDays(parse('2026-03-01'), -1))).toBe('2026-02-28');
    expect(localIso(monday(parse('2026-11-20')))).toBe('2026-11-16');
    expect(localIso(monday(parse('2026-11-16')))).toBe('2026-11-16');
    expect(localIso(monday(parse('2026-11-22')))).toBe('2026-11-16');
  });
  it('place clips a bar to the week', () => {
    const week = { from: '2026-11-16', to: '2026-11-22' };
    expect(place(week, '2026-11-17', '2026-11-19')).toEqual({ gridColumn: '2 / 5' });
    expect(place(week, '2026-11-10', '2026-11-18')).toEqual({ gridColumn: '1 / 4' });
    expect(place(week, '2026-11-20', '2026-12-05')).toEqual({ gridColumn: '5 / 8' });
    expect(place(week, '2026-11-01', '2026-12-05')).toEqual({ gridColumn: '1 / 8' });
    expect(place(week, '2026-11-01', '2026-11-15')).toBe(null);
    expect(place(week, '2026-11-23', '2026-11-30')).toBe(null);
  });
  it('dropping on a day sets the due date; a span moves as a whole', () => {
    expect(droppedOn({ startDate: null, dueDate: '2026-11-18' }, '2026-11-20')).toEqual({ dueDate: '2026-11-20' });
    expect(droppedOn({ startDate: '2026-11-16', dueDate: '2026-11-18' }, '2026-11-20')).toEqual({
      dueDate: '2026-11-20',
      startDate: '2026-11-18',
    });
    expect(droppedOn({ startDate: '2026-11-16', dueDate: '2026-11-18' }, '2026-11-12')).toEqual({
      dueDate: '2026-11-12',
      startDate: '2026-11-10',
    });
  });
  it('an issue with only a start date keeps it unless it would be after the new due date', () => {
    expect(droppedOn({ startDate: '2026-11-16', dueDate: null }, '2026-11-20')).toEqual({ dueDate: '2026-11-20' });
    expect(droppedOn({ startDate: '2026-11-16', dueDate: null }, '2026-11-12')).toEqual({ dueDate: '2026-11-12', startDate: '2026-11-12' });
  });
});

describe('RAID list', () => {
  const f = (over = {}) => ({ type: '', status: 'active', owner: '', overdue: false, q: '', sort: 'score', cell: null, ...over });
  const ctx = { me: 'u1', today: '2026-11-20' };
  const risk = {
    type: 'risk',
    ref: 'R-1',
    number: 1,
    title: 'Vendor delay',
    description: 'The API is late',
    status: 'open',
    active: true,
    owner: { id: 'u1' },
    reviewDate: '2026-11-10',
    probability: 4,
    impact: 3,
    score: 12,
  };
  const decision = {
    type: 'decision',
    ref: 'D-2',
    number: 2,
    title: 'Use SSO',
    description: '',
    status: 'agreed',
    active: false,
    owner: null,
    reviewDate: null,
    probability: null,
    impact: null,
    score: null,
  };
  it('status: active by default, one status, or all', () => {
    expect(matchesFilter(risk, f(), ctx)).toBe(true);
    expect(matchesFilter(decision, f(), ctx)).toBe(false);
    expect(matchesFilter(decision, f({ status: 'agreed' }), ctx)).toBe(true);
    expect(matchesFilter(risk, f({ status: 'agreed' }), ctx)).toBe(false);
    expect(matchesFilter(decision, f({ status: '' }), ctx)).toBe(true);
  });
  it('type, unless the tabs are counting', () => {
    expect(matchesFilter(risk, f({ type: 'decision' }), ctx)).toBe(false);
    expect(matchesFilter(risk, f({ type: 'decision' }), ctx, true)).toBe(true);
  });
  it('owner: me, none or a person', () => {
    expect(matchesFilter(risk, f({ owner: 'me' }), ctx)).toBe(true);
    expect(matchesFilter(risk, f({ owner: 'me' }), { ...ctx, me: 'u2' })).toBe(false);
    expect(matchesFilter(risk, f({ owner: 'none' }), ctx)).toBe(false);
    expect(matchesFilter(decision, f({ owner: 'none', status: '' }), ctx)).toBe(true);
    expect(matchesFilter(risk, f({ owner: 'u1' }), ctx)).toBe(true);
    expect(matchesFilter(risk, f({ owner: 'u9' }), ctx)).toBe(false);
  });
  it('overdue, heat map cell and text', () => {
    expect(matchesFilter(risk, f({ overdue: true }), ctx)).toBe(true);
    expect(matchesFilter(risk, f({ overdue: true }), { ...ctx, today: '2026-11-01' })).toBe(false);
    expect(matchesFilter(risk, f({ cell: { p: 4, i: 3 } }), ctx)).toBe(true);
    expect(matchesFilter(risk, f({ cell: { p: 3, i: 4 } }), ctx)).toBe(false);
    expect(matchesFilter(risk, f({ q: 'VENDOR' }), ctx)).toBe(true);
    expect(matchesFilter(risk, f({ q: 'r-1' }), ctx)).toBe(true);
    expect(matchesFilter(risk, f({ q: 'api is' }), ctx)).toBe(true);
    expect(matchesFilter(risk, f({ q: 'nothing' }), ctx)).toBe(false);
  });
  it('the heat map counts active, rated risks only', () => {
    const heat = riskHeat([
      risk,
      { ...risk },
      { ...risk, active: false },
      { ...risk, probability: null },
      decision,
      { ...risk, probability: 1, impact: 5 },
    ]);
    expect(heat[3][2]).toBe(2);
    expect(heat[0][4]).toBe(1);
    expect(heat.flat().reduce((a, b) => a + b, 0)).toBe(3);
  });
  it('sorts: highest score first with unscored last, and review dates with none last', () => {
    const by = (id) => SORTS.find((s) => s.id === id).cmp;
    expect([decision, risk].sort(by('score')).map((e) => e.ref)).toEqual(['R-1', 'D-2']);
    expect([decision, risk].sort(by('review')).map((e) => e.ref)).toEqual(['R-1', 'D-2']);
    expect([decision, risk].sort(by('ref')).map((e) => e.ref)).toEqual(['R-1', 'D-2']);
    expect([decision, risk].sort(by('title')).map((e) => e.ref)).toEqual(['D-2', 'R-1']);
    expect(SORTS.map((s) => s.id)).toEqual(['score', 'review', 'updated', 'created', 'ref', 'title']);
  });
  it('history lines in words', () => {
    expect(historyText({ field: 'created', to: 'R-1' })).toBe('created R-1');
    expect(historyText({ field: 'status', from: 'open', to: 'closed' })).toBe('changed the status from Open to Closed');
    expect(historyText({ field: 'review_date', from: null, to: '2026-12-01' })).toBe('changed the review date from none to 2026-12-01');
    expect(historyText({ field: 'mitigation', from: 'a', to: 'b' })).toBe('changed the mitigation');
    expect(historyText({ field: 'other', from: 'a', to: '' })).toBe('changed the other from a to none');
  });
});
