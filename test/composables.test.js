// Client action/load layer (src/composables/useAction.js, useLoad.js).
import { describe, it, expect, beforeEach } from 'vitest';
import { ref, nextTick } from 'vue';
import { toasts } from '../src/api.js';
import { attempt, useAction } from '../src/composables/useAction.js';
import { useLoad } from '../src/composables/useLoad.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
beforeEach(() => {
  toasts.length = 0;
});

describe('attempt', () => {
  it('runs then and the ok toast after success', async () => {
    const calls = [];
    const worked = await attempt(
      async () => {
        calls.push('fn');
        return 7;
      },
      { ok: (r) => `Saved ${r}`, then: (r) => calls.push(`then ${r}`) },
    );
    expect(worked).toBe(true);
    expect(calls).toEqual(['fn', 'then 7']);
    expect(toasts.map((t) => [t.message, t.kind])).toEqual([['Saved 7', 'ok']]);
  });
  it('shows the error and skips then and ok on failure', async () => {
    let then = false;
    const worked = await attempt(
      async () => {
        throw new Error('Nope');
      },
      {
        ok: 'Saved',
        then: () => {
          then = true;
        },
      },
    );
    expect(worked).toBe(false);
    expect(then).toBe(false);
    expect(toasts.map((t) => [t.message, t.kind])).toEqual([['Nope', 'error']]);
  });
  it('a failing then is an error too, and no toast without ok', async () => {
    expect(await attempt(() => 1)).toBe(true);
    expect(toasts.length).toBe(0);
    expect(
      await attempt(() => 1, {
        ok: 'Saved',
        then: () => {
          throw new Error('Reload failed');
        },
      }),
    ).toBe(false);
    expect(toasts.map((t) => t.message)).toEqual(['Reload failed']);
  });
});

describe('useAction', () => {
  it('busy is true only while the action runs, also after a failure', async () => {
    const { busy, run } = useAction();
    let release;
    const p = run(
      () =>
        new Promise((r) => {
          release = r;
        }),
      { ok: 'Done' },
    );
    expect(busy.value).toBe(true);
    release();
    expect(await p).toBe(true);
    expect(busy.value).toBe(false);
    expect(
      await run(async () => {
        throw new Error('Bad');
      }),
    ).toBe(false);
    expect(busy.value).toBe(false);
  });
});

describe('useLoad', () => {
  it('loads at once and exposes data', async () => {
    const { data, loading, error } = useLoad(async () => [1, 2], null, { initial: [] });
    expect(loading.value).toBe(true);
    expect(data.value).toEqual([]);
    await tick();
    expect(loading.value).toBe(false);
    expect(error.value).toBe('');
    expect(data.value).toEqual([1, 2]);
  });
  it('a failed first load ends in error, and reload recovers', async () => {
    let fail = true;
    const { data, loading, error, reload } = useLoad(async () => {
      if (fail) throw new Error('Offline');
      return 'ok';
    });
    await tick();
    expect(loading.value).toBe(false);
    expect(error.value).toBe('Offline');
    expect(toasts.length).toBe(0);
    fail = false;
    const p = reload();
    expect(loading.value).toBe(true);
    await p;
    expect(error.value).toBe('');
    expect(data.value).toBe('ok');
  });
  it('a failed reload keeps the data and toasts', async () => {
    let fail = false;
    const { data, loading, error, reload } = useLoad(async () => {
      if (fail) throw new Error('Offline');
      return 'first';
    });
    await tick();
    fail = true;
    const p = reload();
    expect(loading.value).toBe(false); // no skeleton over data already shown
    await p;
    expect(data.value).toBe('first');
    expect(error.value).toBe('');
    expect(toasts.map((t) => [t.message, t.kind])).toEqual([['Offline', 'error']]);
  });
  it('reloads when a source changes; eachTime shows loading again; late answers are dropped', async () => {
    const id = ref(1);
    const waits = {};
    const { data, loading } = useLoad(
      () =>
        new Promise((r) => {
          waits[id.value] = r;
        }),
      id,
      { eachTime: true },
    );
    waits[1]('one');
    await tick();
    expect(data.value).toBe('one');
    id.value = 2;
    await nextTick();
    expect(loading.value).toBe(true);
    const second = waits[2];
    id.value = 3;
    await nextTick();
    waits[3]('three');
    await tick();
    second('two (late)');
    await tick();
    expect(data.value).toBe('three');
    expect(loading.value).toBe(false);
  });
});
