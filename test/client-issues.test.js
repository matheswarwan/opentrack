// Client issue mutations (src/issues.js): updateIssue, changeStatus under workflow rules, patchOptimistic.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { toasts } from '../src/api.js';
import { ui } from '../src/ui.js';
import { transition, canMoveTo } from '../src/workflow.js';
import { updateIssue, changeStatus, patchOptimistic } from '../src/issues.js';

// A fake server: answers are taken from the queue in order; every request is recorded.
let calls;
let answers;
const realFetch = globalThis.fetch;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
beforeEach(() => {
  calls = [];
  answers = [];
  toasts.length = 0;
  globalThis.fetch = async (path, init) => {
    calls.push({ path, method: init.method, body: JSON.parse(init.body) });
    return answers.shift();
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
const tick = () => new Promise((r) => setTimeout(r, 0));

const project = {
  key: 'WEB',
  statuses: [
    { id: 's1', name: 'To Do' },
    { id: 's2', name: 'Doing' },
    { id: 's3', name: 'Done' },
  ],
  workflow: { transitions: { s1: ['s2'] }, adminBypass: false },
};

describe('updateIssue', () => {
  it('sends one PATCH and returns the answer', async () => {
    answers.push(json(200, { issue: { key: 'WEB-1', priority: 'high' }, changed: ['priority'] }));
    const r = await updateIssue('WEB-1', { priority: 'high' });
    expect(calls).toEqual([{ path: '/api/issues/WEB-1', method: 'PATCH', body: { priority: 'high' } }]);
    expect(r.changed).toEqual(['priority']);
  });
  it('rejects with the server message', async () => {
    answers.push(json(403, { error: 'Read only' }));
    await expect(updateIssue('WEB-1', { priority: 'high' })).rejects.toThrow('Read only');
  });
});

describe('changeStatus', () => {
  const issue = { key: 'WEB-1', status: { id: 's1' } };
  it('sends the status on its own when no rule asks for more', async () => {
    answers.push(json(200, { issue: {}, changed: ['status'] }));
    await changeStatus(project, issue, 's2');
    expect(calls.map((c) => c.body)).toEqual([{ statusId: 's2' }]);
    expect(transition.open).toBe(false);
  });
  it('asks for the values a rule needs, then sends the change again with them', async () => {
    answers.push(
      json(422, {
        error: 'Needs an assignee',
        code: 'required',
        status: { id: 's2', name: 'Doing' },
        missing: [{ key: 'assignee', label: 'Assignee' }],
      }),
    );
    answers.push(json(200, { issue: {}, changed: ['status', 'assignee'] }));
    const p = changeStatus(project, issue, 's2');
    await tick();
    expect(transition.open).toBe(true);
    expect(transition.missing).toEqual([{ key: 'assignee', label: 'Assignee' }]);
    transition.resolve({ assigneeId: 'u1' }); // what TransitionDialog does on Move
    const r = await p;
    expect(r.changed).toEqual(['status', 'assignee']);
    expect(calls.map((c) => c.body)).toEqual([{ statusId: 's2' }, { assigneeId: 'u1', statusId: 's2' }]);
  });
  it('a cancelled dialog rejects with cancelled, and sends nothing more', async () => {
    answers.push(
      json(422, {
        error: 'Needs an assignee',
        code: 'required',
        status: { id: 's2', name: 'Doing' },
        missing: [{ key: 'assignee', label: 'Assignee' }],
      }),
    );
    const p = changeStatus(project, issue, 's2');
    await tick();
    transition.resolve(null);
    await expect(p).rejects.toMatchObject({ cancelled: true });
    expect(calls.length).toBe(1);
  });
  it('a refused transition rejects with the server message', async () => {
    answers.push(json(422, { error: 'Moving from To Do to Done is not allowed. Allowed: Doing.', code: 'transition' }));
    await expect(changeStatus(project, issue, 's3')).rejects.toThrow('not allowed');
    expect(canMoveTo(project, 's1', 's3')).toBe(false); // what the status select disables up front
    expect(canMoveTo(project, 's1', 's2')).toBe(true);
  });
});

describe('patchOptimistic', () => {
  it('sets the fields at once, keeps them on success, toasts and marks a change', async () => {
    const issue = { key: 'WEB-1', startDate: null, dueDate: '2026-11-20', title: 'x' };
    const before = ui.changes;
    answers.push(json(200, { issue: {}, changed: ['dueDate'] }));
    const p = patchOptimistic(issue, { dueDate: '2026-11-25' }, 'WEB-1 is now due 25 Nov');
    expect(issue.dueDate).toBe('2026-11-25'); // before the server answered
    expect(await p).toBe(true);
    expect(issue.dueDate).toBe('2026-11-25');
    expect(toasts.map((t) => [t.message, t.kind])).toEqual([['WEB-1 is now due 25 Nov', 'ok']]);
    expect(ui.changes).toBe(before + 1);
  });
  it('puts the fields back and shows the error when the server refuses', async () => {
    const issue = { key: 'WEB-1', startDate: '2026-11-18', dueDate: '2026-11-20', title: 'x' };
    const before = ui.changes;
    answers.push(json(400, { error: 'Due date is before the start date' }));
    expect(await patchOptimistic(issue, { startDate: '2026-11-30', dueDate: '2026-11-25' }, 'Saved')).toBe(false);
    expect(issue).toEqual({ key: 'WEB-1', startDate: '2026-11-18', dueDate: '2026-11-20', title: 'x' });
    expect(toasts.map((t) => [t.message, t.kind])).toEqual([['Due date is before the start date', 'error']]);
    expect(ui.changes).toBe(before);
  });
});
