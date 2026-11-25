// shared/: the modules both the web app and the Worker import. These tests pin that both sides really use them.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { csvCell, csvLine, toCsv } from '../shared/csv.js';
import * as issueMeta from '../shared/issueMeta.js';
import { transitionAllowed, refusalText } from '../shared/workflow.js';
import * as raid from '../shared/raid.js';
import * as serverCsv from '../server/lib/csv.js';
import * as clientCsv from '../src/csv.js';
import * as model from '../server/lib/issues/model.js';
import { TYPES, PRIORITIES, CATEGORIES, LINK_TYPES } from '../src/meta.js';
import * as serverRaid from '../server/lib/raid.js';
import * as clientRaid from '../src/raid.js';
import { transitionAllowed as serverAllowed } from '../server/lib/workflow.js';
import { canMoveTo, moveRefusal } from '../src/workflow.js';

describe('shared/csv', () => {
  it('neutralises formulas in text but not in numbers', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('-5')).toBe("'-5");
    expect(csvCell(-5)).toBe('-5');
    expect(csvLine(['a,b', 'x'])).toBe('"a,b",x');
    expect(toCsv([['h'], ['v']])).toBe('h\nv');
  });
  it('is the same function on both sides', () => {
    expect(serverCsv.csvCell).toBe(csvCell);
    expect(clientCsv.csvCell).toBe(csvCell);
    expect(clientCsv.toCsv).toBe(toCsv);
  });
});

describe('shared/issueMeta', () => {
  it('server lists and client decorated lists use the same ids in the same order', () => {
    expect(model.TYPES).toBe(issueMeta.TYPES);
    expect(model.PRIORITIES).toBe(issueMeta.PRIORITIES);
    expect(TYPES.map((t) => t.id)).toEqual(issueMeta.TYPES);
    expect(PRIORITIES.map((p) => p.id)).toEqual(issueMeta.PRIORITIES);
    expect(CATEGORIES.map((c) => c.id)).toEqual(issueMeta.STATUS_CATEGORIES);
    expect(LINK_TYPES.map((l) => l.id)).toEqual(issueMeta.LINK_TYPES);
    for (const t of [...TYPES, ...PRIORITIES, ...CATEGORIES]) expect(t.label).toBeTruthy();
  });
});

describe('shared/workflow', () => {
  const wf = { transitions: { a: ['b'], c: [] }, adminBypass: true };
  it('allows and refuses moves', () => {
    expect(transitionAllowed(wf, 'a', 'b')).toBe(true);
    expect(transitionAllowed(wf, 'a', 'c')).toBe(false);
    expect(transitionAllowed(wf, 'c', 'a')).toBe(false);
    expect(transitionAllowed(wf, 'b', 'a')).toBe(true); // not a key: no limits
    expect(transitionAllowed(wf, 'c', 'c')).toBe(true);
    expect(transitionAllowed({ transitions: null }, 'a', 'c')).toBe(true);
    expect(transitionAllowed(null, 'a', 'c')).toBe(true);
    expect(serverAllowed).toBe(transitionAllowed);
  });
  it('the browser applies the admin bypass on top', () => {
    const statuses = [
      { id: 'a', name: 'To Do' },
      { id: 'b', name: 'Doing' },
      { id: 'c', name: 'Done' },
    ];
    expect(canMoveTo({ workflow: wf, canAdmin: false, statuses }, 'a', 'c')).toBe(false);
    expect(canMoveTo({ workflow: wf, canAdmin: true, statuses }, 'a', 'c')).toBe(true);
    expect(canMoveTo({ workflow: { ...wf, adminBypass: false }, canAdmin: true, statuses }, 'a', 'c')).toBe(false);
    expect(moveRefusal({ workflow: wf, statuses }, 'a', 'c')).toBe(refusalText('To Do', 'Done', ['Doing']));
    expect(moveRefusal({ workflow: wf, statuses }, 'c', 'a')).toBe('Moving from Done to To Do is not allowed. Allowed: none.');
  });
});

describe('shared/raid', () => {
  it('scores and bands', () => {
    expect(raid.riskScore(3, 4)).toBe(12);
    expect(raid.riskScore(null, 4)).toBe(null);
    expect([0, 1, 4, 5, 11, 12, 25].map(raid.scoreBand)).toEqual([null, 'low', 'low', 'medium', 'medium', 'high', 'high']);
    expect(clientRaid.band(12).label).toBe('High');
    expect(clientRaid.band(null)).toBe(null);
    expect(serverRaid.TOP_RISK_SCORE).toBe(raid.HIGH_SCORE);
  });
  it('both sides use the same rules', () => {
    expect(serverRaid.statusesFor).toBe(raid.statusesFor);
    expect(clientRaid.statusesFor).toBe(raid.statusesFor);
    expect(serverRaid.isOverdue).toBe(raid.isOverdue);
    expect(clientRaid.isOverdue).toBe(raid.isOverdue);
    expect(clientRaid.RAID_TYPES.map((t) => t.id)).toEqual(raid.RAID_TYPES);
    expect(serverRaid.entryOut({ number: 1, status: 'superseded', title: 't' }).active).toBe(false);
    expect(serverRaid.entryOut({ number: 1, status: 'monitoring', title: 't' }).active).toBe(true);
    expect(clientRaid.historyText({ field: 'status', from: 'open', to: 'closed' })).toBe('changed the status from Open to Closed');
    expect(clientRaid.historyText({ field: 'mitigation', from: 'a', to: 'b' })).toBe('changed the mitigation');
  });
});

describe('shared/ stays pure', () => {
  it('imports nothing from src/, server/, vue or the platform', () => {
    for (const f of readdirSync(new URL('../shared/', import.meta.url)).filter((n) => n.endsWith('.js'))) {
      const text = readFileSync(new URL(`../shared/${f}`, import.meta.url), 'utf8');
      expect(text, f).not.toMatch(/from ['"](\.\.\/(src|server)|vue|node:|cloudflare:)/);
    }
  });
});
