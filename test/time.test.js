// server/lib/time.js: date helpers, and "today" in the workspace time zone for default dates.
import { describe, it, expect } from 'vitest';
import { withAdmin } from './helpers.js';
import { addDays, daysBetween, mondayOf, validDate, validTimeZone, workspaceTz, localParts, clock } from '../server/lib/time.js';
import { isoDate } from '../server/lib/http.js';

describe('time helpers', () => {
  it('adds days across months, years and leap days', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-06-15', 0)).toBe('2026-06-15');
  });

  it('counts days between dates', () => {
    expect(daysBetween('2026-06-15', '2026-06-18')).toBe(3);
    expect(daysBetween('2026-06-18', '2026-06-15')).toBe(-3);
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
  });

  it('finds the Monday of a week', () => {
    expect(mondayOf('2026-06-17')).toBe('2026-06-15');
    expect(mondayOf('2026-06-15')).toBe('2026-06-15');
    expect(mondayOf('2026-06-14')).toBe('2026-06-08'); // Sunday belongs to the week before
  });

  it('accepts only real calendar dates', () => {
    expect(validDate('2026-02-28')).toBe(true);
    expect(validDate('2028-02-29')).toBe(true);
    expect(validDate('2026-02-29')).toBe(false);
    expect(validDate('2026-02-31')).toBe(false);
    expect(validDate('2026-13-01')).toBe(false);
    expect(validDate('2026-1-1')).toBe(false);
    expect(validDate(20260101)).toBe(false);
  });

  it('isoDate refuses impossible dates', () => {
    expect(isoDate('2026-02-28', 'Due date')).toBe('2026-02-28');
    expect(isoDate(undefined)).toBe(undefined);
    expect(isoDate('')).toBe(null);
    expect(isoDate(null)).toBe(null);
    expect(() => isoDate('2026-02-31', 'Due date')).toThrow('Due date is not a real date');
    expect(() => isoDate('31/02/2026', 'Due date')).toThrow('Due date must be YYYY-MM-DD');
  });

  it('falls back to the default zone for a missing or bad time zone', () => {
    expect(validTimeZone('America/Toronto')).toBe(true);
    expect(validTimeZone('Mars/Olympus')).toBe(false);
    expect(workspaceTz({ timeZone: 'America/Toronto' })).toBe('America/Toronto');
    expect(workspaceTz({ timeZone: 'Mars/Olympus' })).toBe('America/Vancouver');
    expect(workspaceTz({})).toBe('America/Vancouver');
  });

  it('reads the clock from env.now and gives local parts', () => {
    expect(clock({ now: 5 })).toBe(5);
    expect(clock({ now: () => 7 })).toBe(7);
    expect(clock({ now: '2026-06-16T03:30:00Z' })).toBe(Date.parse('2026-06-16T03:30:00Z'));
    expect(localParts(Date.parse('2026-06-16T03:30:00Z'), 'America/Vancouver')).toMatchObject({ date: '2026-06-15', hour: 20, weekday: 1 });
  });
});

describe('default dates use the workspace day', () => {
  // 03:30 UTC on the 16th is 20:30 on the 15th in Vancouver (the default workspace zone)
  const EVENING = '2026-06-16T03:30:00Z';

  it('a work log without a date lands on the workspace day, not the UTC date', async () => {
    const ctx = await withAdmin({ now: EVENING });
    await ctx.admin.post('/api/projects', { key: 'WEB', name: 'Website' });
    const key = (await ctx.admin.post('/api/issues', { projectKey: 'WEB', title: 'Work' })).body.issue.key;
    expect((await ctx.admin.post(`/api/issues/${key}/worklogs`, { hours: 1 })).status).toBe(201);
    const rows = await ctx.db.all('SELECT work_date FROM worklogs');
    expect(rows.map((r) => r.work_date)).toEqual(['2026-06-15']);
    // the default timesheet range (the last 7 days) ends on the same day
    const sheet = (await ctx.admin.get('/api/timesheet')).body;
    expect(sheet.to).toBe('2026-06-15');
    expect(sheet.from).toBe('2026-06-09');
  });

  it('follows the timeZone setting', async () => {
    const ctx = await withAdmin({ now: EVENING });
    expect((await ctx.admin.patch('/api/admin/settings', { timeZone: 'Europe/London' })).status).toBe(200);
    await ctx.admin.post('/api/projects', { key: 'WEB', name: 'Website' });
    const key = (await ctx.admin.post('/api/issues', { projectKey: 'WEB', title: 'Work' })).body.issue.key;
    await ctx.admin.post(`/api/issues/${key}/worklogs`, { hours: 1 });
    expect((await ctx.db.all('SELECT work_date FROM worklogs')).map((r) => r.work_date)).toEqual(['2026-06-16']);
  });

  it('refuses an impossible date on an issue', async () => {
    const ctx = await withAdmin();
    await ctx.admin.post('/api/projects', { key: 'WEB', name: 'Website' });
    const r = await ctx.admin.post('/api/issues', { projectKey: 'WEB', title: 'Work', dueDate: '2026-02-31' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Due date is not a real date');
  });
});
