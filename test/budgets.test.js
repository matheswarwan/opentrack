// Project budgets: CRUD and permissions, rates with effective dates, billable flag, burn, forecast, alerts,
// status report Budget RAG, CSV export and backups.
import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser } from './helpers.js';
import { budgetRag, rateResolver } from '../server/lib/budgets.js';
import { mondayOf } from '../server/lib/time.js';
import { suggestRag } from '../server/lib/statusReports.js';

const NOW = '2026-06-17T12:00:00.000Z'; // a Wednesday
const base = '/api/projects/WEB/budget';
let ctx, bob, carol, gina, comp;

async function issue(fields) {
  const r = await bob.client.post('/api/issues', { projectKey: 'WEB', ...fields });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.issue;
}
async function log(who, key, hours, workDate, extra = {}) {
  const r = await who.client.post(`/api/issues/${key}/worklogs`, { hours, workDate, ...extra });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
}
const notices = async (who) => (await who.client.get('/api/notifications')).body.notifications.filter((n) => n.type === 'budget');

// WEB: private, Bob's (project admin). Carol is a member, Gina a guest.
beforeEach(async () => {
  ctx = await withAdmin({ now: NOW });
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
  carol = await addUser(ctx, { email: 'carol@example.com', name: 'Carol' });
  gina = await addUser(ctx, { email: 'gina@client.example', name: 'Gina Guest', role: 'guest' });
  await bob.client.post('/api/projects', { key: 'WEB', name: 'Website', visibility: 'private' });
  await bob.client.put(`/api/projects/WEB/members/${carol.id}`, { role: 'member' });
  await bob.client.put(`/api/projects/WEB/members/${gina.id}`, { role: 'guest-comment' });
  comp = (await bob.client.post('/api/projects/WEB/components', { name: 'Frontend' })).body.component;
  await issue({ type: 'epic', title: 'Checkout' }); // WEB-1
  await issue({ type: 'story', title: 'Cart page', parentKey: 'WEB-1', estimateHours: 20, components: [comp.id] }); // WEB-2
  await issue({ title: 'Hosting', estimateHours: 10 }); // WEB-3
});

/** The money scenario: rates, logs inside and outside the window, one non-billable entry. */
async function moneySetup() {
  expect((await bob.client.put(base, { kind: 'money', amount: 10000, startDate: '2026-06-01' })).status).toBe(200);
  for (const r of [
    { scope: 'default', rate: 100, effectiveFrom: '2026-01-01' },
    { scope: 'default', rate: 120, effectiveFrom: '2026-06-15' },
    { scope: 'role', role: 'admin', rate: 200, effectiveFrom: '2026-01-01' },
    { scope: 'person', userId: carol.id, rate: 150, effectiveFrom: '2026-06-10' },
  ])
    expect((await bob.client.post(`${base}/rates`, r)).status).toBe(201);
  await log(carol, 'WEB-2', 4, '2026-06-08'); // default 100 (her own rate starts 06-10): 400
  await log(carol, 'WEB-2', 2, '2026-06-16'); // her rate 150: 300
  await log(bob, 'WEB-3', 3, '2026-06-09'); // project admin role 200: 600
  await log(bob, 'WEB-3', 5, '2026-05-20'); // before the budget starts
  await log(carol, 'WEB-3', 1, '2026-06-16', { billable: false });
}

describe('budget settings and permissions', () => {
  it('lets project admins set, change and remove it; members get hours only; guests get nothing', async () => {
    expect((await bob.client.get(base)).body).toMatchObject({ budget: null, burn: null, canAdmin: true, rates: [] });
    expect((await carol.client.put(base, { kind: 'hours', amount: 10 })).status).toBe(403);
    expect((await bob.client.put(base, { kind: 'days', amount: 10 })).status).toBe(400);
    expect((await bob.client.put(base, { kind: 'hours' })).status).toBe(400);
    expect((await bob.client.put(base, { kind: 'hours', amount: 10, startDate: '2026-06-10', endDate: '2026-06-01' })).status).toBe(400);
    expect((await bob.client.put(base, { kind: 'money', amount: 10, currency: 'dollars' })).status).toBe(400);
    expect((await bob.client.put(base, { kind: 'hours', amount: 10, thresholds: [] })).status).toBe(400);

    await moneySetup();
    const admin = (await bob.client.get(base)).body;
    expect(admin.budget).toMatchObject({
      kind: 'money',
      amount: 10000,
      currency: 'CAD',
      startDate: '2026-06-01',
      endDate: null,
      thresholds: [80, 100],
    });
    expect(admin.rates).toHaveLength(4);
    expect(admin.burn.usage).toMatchObject({ hours: 9, cost: 1300, nonBillableHours: 1, pctUsed: 13 });
    expect((await ctx.admin.get(base)).body.burn.usage.cost).toBe(1300); // workspace admins see money too

    const member = (await carol.client.get(base)).body;
    expect(member.canAdmin).toBe(false);
    expect(member.rates).toBeUndefined();
    expect(member.burn.hoursOnly).toBe(true);
    expect(member.burn.usage).toEqual({ hours: 9, nonBillableHours: 1, pctUsed: 13 });
    const text = JSON.stringify(member);
    for (const word of ['"amount"', '"cost"', '"rate"', '"currency"', '"averageRate"', '"value"']) expect(text).not.toContain(word);
    expect(member.burn.people.map((p) => p.name)).toEqual(['Carol', 'Bob']);

    expect((await gina.client.get(base)).status).toBe(404);
    expect((await gina.client.get(`${base}/export.csv`)).status).toBe(404);
    expect((await carol.client.post(`${base}/rates`, { scope: 'default', rate: 1 })).status).toBe(403);

    expect((await bob.client.del(base)).status).toBe(200);
    expect((await bob.client.get(base)).body.budget).toBe(null);
    expect((await bob.client.get(base)).body.rates).toHaveLength(4); // rates stay
  });

  it('checks epic and component lines belong to the project', async () => {
    await bob.client.post('/api/projects', { key: 'OTH', name: 'Other' });
    const other = (await bob.client.post('/api/issues', { projectKey: 'OTH', title: 'E', type: 'epic' })).body.issue;
    expect(
      (await bob.client.put(base, { kind: 'hours', amount: 100, lines: [{ targetType: 'epic', targetId: other.id, hours: 5 }] })).status,
    ).toBe(400);
    expect(
      (
        await bob.client.put(base, {
          kind: 'hours',
          amount: 100,
          lines: [
            { targetType: 'epic', targetId: 'x', hours: 5 },
            { targetType: 'epic', targetId: 'x', hours: 5 },
          ],
        })
      ).status,
    ).toBe(400);
    const epic = (await bob.client.get('/api/issues/WEB-1')).body.issue;
    const r = await bob.client.put(base, {
      kind: 'hours',
      amount: 100,
      lines: [
        { targetType: 'epic', targetId: epic.id, hours: 10 },
        { targetType: 'component', targetId: comp.id, hours: 4 },
      ],
    });
    expect(r.status).toBe(200);
    await log(carol, 'WEB-2', 6, '2026-06-16');
    const burn = (await carol.client.get(base)).body.burn;
    expect(burn.epics.find((e) => e.key === 'WEB-1')).toMatchObject({ hours: 6, budgetHours: 10, pctUsed: 60 });
    expect(burn.components).toEqual([{ id: comp.id, name: 'Frontend', hours: 6, budgetHours: 4, pctUsed: 150 }]);
  });
});

describe('rates and burn', () => {
  it('resolves person over role over default, newest effective date first', () => {
    const rates = [
      { scope: 'default', rate: 100, effective_from: '2026-01-01' },
      { scope: 'default', rate: 120, effective_from: '2026-06-15' },
      { scope: 'role', role: 'admin', rate: 200, effective_from: '2026-03-01' },
      { scope: 'person', user_id: 'c', rate: 150, effective_from: '2026-06-10' },
    ];
    const rate = rateResolver(
      rates,
      new Map([
        ['b', 'admin'],
        ['c', 'member'],
      ]),
    );
    expect([rate('x', '2025-12-31'), rate('x', '2026-06-14'), rate('x', '2026-06-15')]).toEqual([null, 100, 120]);
    expect([rate('b', '2026-02-01'), rate('b', '2026-03-01')]).toEqual([100, 200]);
    expect([rate('c', '2026-06-09'), rate('c', '2026-06-10')]).toEqual([100, 150]);
    expect(mondayOf('2026-06-17')).toBe('2026-06-15');
    expect(mondayOf('2026-06-14')).toBe('2026-06-08');
  });

  it('adds up hours and cost by week, person and epic, and forecasts completion', async () => {
    await moneySetup();
    const b = (await bob.client.get(base)).body.burn;
    expect(b.asOf).toBe('2026-06-17');
    expect(b.weeks).toEqual([
      { week: '2026-06-08', hours: 7, cost: 1000 },
      { week: '2026-06-15', hours: 2, cost: 300 },
    ]);
    expect(b.people).toEqual([
      { id: carol.id, name: 'Carol', hours: 6, nonBillableHours: 1, cost: 700 },
      { id: bob.id, name: 'Bob', hours: 3, nonBillableHours: 0, cost: 600 },
    ]);
    expect(b.epics.map((e) => [e.key, e.hours, e.cost])).toEqual([
      ['WEB-1', 6, 700],
      [null, 3, 600],
    ]);
    // remaining: WEB-2 20 - 6 = 14, WEB-3 10 - 9 (all hours, also outside the window) = 1
    expect(b.forecast.remainingHours).toBe(15);
    // burn: 9 billable hours over 10 days (first log 06-08 to 06-17) = 6.3 h a week; average rate 1300 / 9
    expect(b.forecast.burnRateHours).toBe(6.3);
    expect(b.forecast.averageRate).toBe(144.44);
    expect(b.forecast.atCompletion).toBeCloseTo(1300 + 15 * (1300 / 9), 1);
    expect(b.forecast.finishDate).toBe('2026-07-04'); // 15 / 6.3 weeks = 16.7 days
    expect(b.forecast.overBudget).toBe(false);
    expect(b.chart.labels[0]).toBe('2026-06-01');
    expect(b.chart.labels.at(-1)).toBe('2026-06-29');
    expect(b.chart.value.budget.every((v) => v === 10000)).toBe(true);
    expect(b.chart.value.actual).toEqual([0, 1000, 1300, null, null]);
    expect(b.chart.value.forecast[2]).toBe(1300);
    expect(b.chart.value.forecast.at(-1)).toBeCloseTo(b.forecast.atCompletion, 1);
    // a rate change with an earlier effective date reprices only the days it covers
    await bob.client.post(`${base}/rates`, { scope: 'person', userId: carol.id, rate: 50, effectiveFrom: '2026-06-16' });
    expect((await bob.client.get(base)).body.burn.usage.cost).toBe(1100);
  });

  it('hours budgets count billable hours and flag a forecast over budget', async () => {
    await bob.client.put(base, { kind: 'hours', amount: 12, endDate: '2026-06-20' });
    await log(carol, 'WEB-2', 8, '2026-06-15');
    await log(carol, 'WEB-2', 2, '2026-06-16', { billable: false });
    const b = (await carol.client.get(base)).body.burn;
    expect(b.budget).toMatchObject({ kind: 'hours', amount: 12 });
    expect(b.usage).toMatchObject({ hours: 8, value: 8, remaining: 4, pctUsed: 66.67 });
    expect(b.forecast).toMatchObject({ remainingHours: 20, atCompletion: 28, overBudget: true, finishAfterEnd: true });
  });
});

describe('billable flag', () => {
  it('defaults to billable; authors and project admins can change it; bulk for own entries', async () => {
    await log(carol, 'WEB-2', 1, '2026-06-15');
    await log(carol, 'WEB-2', 2, '2026-06-16', { billable: false });
    await log(bob, 'WEB-3', 3, '2026-06-16');
    const logs = (await bob.client.get('/api/issues/WEB-2')).body.issue.worklogs;
    expect(logs.map((w) => w.billable).sort()).toEqual([false, true]);
    const ts = (await carol.client.get('/api/timesheet?from=2026-06-15&to=2026-06-21')).body;
    expect(ts.entries.map((e) => e.billable).sort()).toEqual([false, true]);
    expect(ts.nonBillable).toBe(2);

    const bobLog = (await bob.client.get('/api/issues/WEB-3')).body.issue.worklogs[0];
    const carolLogs = ts.entries.map((e) => e.id);
    expect((await carol.client.patch(`/api/worklogs/${bobLog.id}`, { billable: false })).status).toBe(403);
    expect((await carol.client.post('/api/worklogs/billable', { ids: [...carolLogs, bobLog.id], billable: false })).status).toBe(403);
    expect((await carol.client.patch(`/api/worklogs/${carolLogs[0]}`, { billable: 'no' })).status).toBe(400);
    expect((await carol.client.post('/api/worklogs/billable', { ids: carolLogs, billable: false })).body).toEqual({ ok: true, changed: 2 });
    expect((await carol.client.get('/api/timesheet?from=2026-06-15&to=2026-06-21')).body.nonBillable).toBe(3);
    expect((await bob.client.patch(`/api/worklogs/${carolLogs[0]}`, { billable: true })).status).toBe(200); // project admin
    expect((await carol.client.get('/api/timesheet?from=2026-06-15&to=2026-06-21')).body.nonBillable).toBeLessThan(3);
    expect((await carol.client.post('/api/worklogs/billable', { ids: ['nope'], billable: true })).status).toBe(404);
  });
});

describe('alerts', () => {
  it('notifies project admins once per threshold', async () => {
    await bob.client.put(base, { kind: 'hours', amount: 10, thresholds: [50, 100] });
    await log(carol, 'WEB-2', 4, '2026-06-15');
    expect(await notices(bob)).toHaveLength(0);
    await log(carol, 'WEB-2', 2, '2026-06-15'); // 60%
    let n = await notices(bob);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ message: 'Budget for Website: 60% used, past the 50% alert.', link: '/projects/WEB/reports' });
    await log(carol, 'WEB-2', 1, '2026-06-16'); // 70%: nothing new
    await carol.client.post('/api/worklogs/billable', {
      ids: (await carol.client.get('/api/timesheet?from=2026-06-15&to=2026-06-21')).body.entries.map((e) => e.id).slice(0, 1),
      billable: false,
    });
    await carol.client.post('/api/worklogs/billable', {
      ids: (await carol.client.get('/api/timesheet?from=2026-06-15&to=2026-06-21')).body.entries.map((e) => e.id).slice(0, 1),
      billable: true,
    });
    expect(await notices(bob)).toHaveLength(1);
    await log(carol, 'WEB-2', 4, '2026-06-16'); // 110%
    n = await notices(bob);
    expect(n).toHaveLength(2);
    expect(n.map((x) => x.message)).toContain('Budget for Website: 110% used, past the 100% alert.');
    expect(await notices(carol)).toHaveLength(0); // members are not told
    expect(await notices(gina)).toHaveLength(0);
    // a new amount starts the alerts again
    await bob.client.put(base, { kind: 'hours', amount: 20, thresholds: [50, 100] });
    expect(await notices(bob)).toHaveLength(3);
  });
});

describe('status reports', () => {
  it('uses the budget for the Budget RAG when there is one, else the estimates', async () => {
    await log(carol, 'WEB-2', 2, '2026-06-16');
    let rep = (await bob.client.post('/api/projects/WEB/status-reports', {})).body.report;
    expect(rep.data.budget).toMatchObject({ estimateHours: 30, loggedHours: 2 }); // fallback
    expect(rep.rag.budget.value).toBe('green');

    await bob.client.put(base, { kind: 'money', amount: 1000 });
    await bob.client.post(`${base}/rates`, { scope: 'default', rate: 100, effectiveFrom: '2026-01-01' });
    rep = (await bob.client.post('/api/projects/WEB/status-reports', {})).body.report;
    expect(rep.data.budget).toMatchObject({ source: 'budget', kind: 'money', pctUsed: 20 });
    expect(JSON.stringify(rep.data.budget)).not.toContain('1000'); // no money in reports
    // 2 h used, 28 h remaining at 100 = 3000 at completion: 300% of the budget
    expect(rep.rag.budget).toMatchObject({ value: 'red', why: ['20% of the budget used', 'Forecast at completion: 300% of the budget'] });
  });

  it('rates the budget by thresholds and forecast', () => {
    const s = (pctUsed, forecastPct) => budgetRag({ kind: 'money', thresholds: [80, 100], pctUsed, forecastPct }).value;
    expect([s(10, 90), s(10, 105), s(80, 95), s(100, 100), s(50, 111)]).toEqual(['green', 'amber', 'amber', 'red', 'red']);
    const data = {
      counts: { overdue: 0, blocked: 0, highBugs: 0 },
      burndown: null,
      overdueReleases: [],
      budget: { source: 'budget', kind: 'hours', thresholds: [80], pctUsed: 85, forecastPct: 90, hoursUsed: 85, budgetHours: 100 },
    };
    const r = suggestRag(data);
    expect(r.budget).toMatchObject({
      value: 'amber',
      why: ['85 of 100 budgeted hours used (85%)', 'Forecast at completion: 90% of the budget'],
    });
    expect(r.overall.value).toBe('amber');
  });
});

describe('export and backups', () => {
  it('exports billable hours and cost by person and week for project admins', async () => {
    await moneySetup();
    expect((await carol.client.get(`${base}/export.csv`)).status).toBe(403);
    expect((await bob.client.get(`${base}/export.csv?from=2026-06-20&to=2026-06-01`)).status).toBe(400);
    const r = await bob.client.get(`${base}/export.csv?from=2026-05-01&to=2026-06-30`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toContain('web-billable-2026-05-01-to-2026-06-30.csv');
    expect(r.body.split('\n')).toEqual([
      'Week starting,Person,Email,Billable hours,Hours without a rate,Cost,Currency',
      '2026-05-18,Bob,bob@example.com,5,0,1000,CAD',
      '2026-06-08,Bob,bob@example.com,3,0,600,CAD',
      '2026-06-08,Carol,carol@example.com,4,0,400,CAD',
      '2026-06-15,Carol,carol@example.com,2,0,300,CAD',
    ]);
    // default range: the budget start to today
    expect((await bob.client.get(`${base}/export.csv`)).body.split('\n')).toHaveLength(4);
  });

  it('full backups and project exports include the budget tables', async () => {
    await moneySetup();
    await bob.client.put(base, {
      kind: 'money',
      amount: 1000,
      startDate: '2026-06-01',
      lines: [{ targetType: 'component', targetId: comp.id, hours: 4 }],
    }); // 130%: alerts
    const full = await ctx.admin.get('/api/admin/backup');
    const b = typeof full.body === 'string' ? JSON.parse(full.body) : full.body;
    expect(b.schema).toBe('0033_security.sql');
    expect(b.tables.project_budgets).toEqual([expect.objectContaining({ kind: 'money', amount: 1000, currency: 'CAD' })]);
    expect(b.tables.budget_rates).toHaveLength(4);
    expect(b.tables.budget_lines).toHaveLength(1);
    expect(b.tables.budget_alerts.map((a) => a.threshold).sort()).toEqual([100, 80]);
    expect(b.tables.worklogs.filter((w) => w.billable === 0)).toHaveLength(1);
    const p = await bob.client.get('/api/projects/WEB/export.json');
    const pb = typeof p.body === 'string' ? JSON.parse(p.body) : p.body;
    expect(pb.tables.project_budgets).toHaveLength(1);
    expect(pb.tables.budget_rates).toHaveLength(4);
  });
});
