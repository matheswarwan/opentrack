// Client calendar-day helpers (src/dates.js).
import { describe, it, expect } from 'vitest';
import { pad, localIso, today, addDays, dayDiff, mondayOf, fmtHours } from '../src/dates.js';

describe('today', () => {
  it('is the local calendar day, not the UTC day', () => {
    // Built from local parts: 23:30 local is still the same local day whatever the UTC day is.
    const late = new Date(2026, 10, 20, 23, 30);
    expect(today(late)).toBe('2026-11-20');
    const early = new Date(2026, 0, 1, 0, 5);
    expect(today(early)).toBe('2026-01-01');
    expect(localIso(new Date(2026, 2, 9))).toBe('2026-03-09');
  });
  it('defaults to now', () => {
    expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(today()).toBe(localIso(new Date()));
  });
});

describe('day arithmetic', () => {
  it('adds and subtracts days across months, years and leap days', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-11-20', 0)).toBe('2026-11-20');
    expect(addDays('2026-03-07', 14)).toBe('2026-03-21'); // across a daylight saving change
  });
  it('counts whole days between two days', () => {
    expect(dayDiff('2026-11-20', '2026-11-23')).toBe(3);
    expect(dayDiff('2026-11-23', '2026-11-20')).toBe(-3);
    expect(dayDiff('2026-03-07', '2026-03-09')).toBe(2);
    expect(dayDiff('2026-11-20', '2026-11-20')).toBe(0);
  });
  it('finds the Monday of a week', () => {
    expect(mondayOf('2026-11-18')).toBe('2026-11-16'); // Wednesday
    expect(mondayOf('2026-11-16')).toBe('2026-11-16'); // Monday
    expect(mondayOf('2026-11-22')).toBe('2026-11-16'); // Sunday
    expect(mondayOf('2026-12-01')).toBe('2026-11-30');
  });
});

describe('formatting', () => {
  it('pads to two digits', () => {
    expect(pad(3)).toBe('03');
    expect(pad(12)).toBe('12');
  });
  it('rounds hours', () => {
    expect(fmtHours(1.256)).toBe('1.26');
    expect(fmtHours(2)).toBe('2');
    expect(fmtHours(7.54, 1)).toBe('7.5');
    expect(fmtHours(null)).toBe('0');
    expect(fmtHours('1.5', 1)).toBe('1.5');
  });
});
