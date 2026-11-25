// src/composables/useCrud.js: the list, add/edit form and delete that the settings panels share.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { toasts } from '../src/api.js';
import { useCrud } from '../src/composables/useCrud.js';

let calls; // [method, path, body]
let rows;
let failNext;
let answer; // what confirm() says

beforeEach(() => {
  toasts.length = 0;
  calls = [];
  rows = [{ id: 'a', name: 'Alpha' }];
  failNext = '';
  answer = true;
  vi.stubGlobal('confirm', () => answer);
  vi.stubGlobal('fetch', async (path, { method, body }) => {
    calls.push([method, path, body ? JSON.parse(body) : undefined]);
    const json = (status, data) => ({ ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => data });
    if (failNext === method) {
      failNext = '';
      return json(400, { error: 'Refused' });
    }
    if (method === 'POST') rows.push({ id: 'new1', ...JSON.parse(body) });
    if (method === 'DELETE') rows = rows.filter((r) => !path.endsWith(`/${r.id}`));
    return json(200, { things: rows, extra: 5 });
  });
});
afterEach(() => vi.unstubAllGlobals());

const make = (more = {}) => useCrud({ base: () => '/api/things', list: (r) => r.things, blank: (t) => ({ name: t?.name || '' }), ...more });

describe('useCrud', () => {
  it('loads the list and tells loaded() about the response', async () => {
    let seen = null;
    const c = make({
      loaded: (r) => {
        seen = r.extra;
      },
    });
    await c.load();
    expect(c.items.value.map((t) => t.id)).toEqual(['a']);
    expect(seen).toBe(5);
    expect(calls).toEqual([['GET', '/api/things', undefined]]);
  });

  it('a failed load is a toast and keeps the list', async () => {
    const c = make();
    failNext = 'GET';
    await c.load();
    expect(c.items.value).toEqual([]);
    expect(toasts.map((t) => [t.message, t.kind])).toEqual([['Refused', 'error']]);
  });

  it('edit fills the form for a new item or an existing one', () => {
    const c = make();
    c.edit(null);
    expect(c.editing.value).toBe('new');
    expect(c.form.name).toBe('');
    c.edit({ id: 'a', name: 'Alpha' });
    expect(c.editing.value).toBe('a');
    expect(c.form.name).toBe('Alpha');
  });

  it('save posts a new item, closes the form, reloads, then calls changed', async () => {
    const order = [];
    const c = make({ saved: 'Thing saved', changed: () => order.push(`changed with ${c.items.value.length}`) });
    c.edit(null);
    c.form.name = 'Beta';
    const p = c.save();
    expect(c.busy.value).toBe(true);
    expect(await p).toBe(true);
    expect(c.busy.value).toBe(false);
    expect(calls).toEqual([
      ['POST', '/api/things', { name: 'Beta' }],
      ['GET', '/api/things', undefined],
    ]);
    expect(c.editing.value).toBe(null);
    expect(order).toEqual(['changed with 2']);
    expect(toasts.map((t) => t.message)).toEqual(['Thing saved']);
  });

  it('save patches an existing item with what body() gives', async () => {
    const c = make({ body: (isNew) => ({ name: c.form.name.trim(), isNew }) });
    c.edit({ id: 'a', name: 'Alpha' });
    c.form.name = ' Alpha 2 ';
    await c.save();
    expect(calls[0]).toEqual(['PATCH', '/api/things/a', { name: 'Alpha 2', isNew: false }]);
    expect(toasts.length).toBe(0);
  });

  it('a refused save keeps the form open and does not reload', async () => {
    let changed = false;
    const c = make({
      saved: 'Thing saved',
      changed: () => {
        changed = true;
      },
    });
    c.edit(null);
    failNext = 'POST';
    expect(await c.save()).toBe(false);
    expect(c.editing.value).toBe('new');
    expect(c.busy.value).toBe(false);
    expect(changed).toBe(false);
    expect(calls.length).toBe(1);
    expect(toasts.map((t) => [t.message, t.kind])).toEqual([['Refused', 'error']]);
  });

  it('remove asks first, then deletes, reloads and calls changed', async () => {
    let changed = 0;
    const c = make({
      changed: () => {
        changed++;
      },
    });
    await c.load();
    answer = false;
    expect(await c.remove(c.items.value[0], 'Delete Alpha?')).toBe(false);
    expect(calls.length).toBe(1);
    answer = true;
    expect(await c.remove(c.items.value[0], 'Delete Alpha?')).toBe(true);
    expect(calls.slice(1)).toEqual([
      ['DELETE', '/api/things/a', undefined],
      ['GET', '/api/things', undefined],
    ]);
    expect(c.items.value).toEqual([]);
    expect(changed).toBe(1);
  });
});
