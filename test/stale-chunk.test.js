import { describe, it, expect, vi } from 'vitest';
import { isStaleChunkError, shouldReload, installStaleChunkReload } from '../src/staleChunk.js';

function mem() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
}

describe('stale page bundles after a deploy', () => {
  it("recognises the browsers' failed dynamic import messages", () => {
    expect(
      isStaleChunkError(
        new TypeError('Failed to fetch dynamically imported module: https://tracker.example.com/assets/BoardView-PfsqQpDf.js'),
      ),
    ).toBe(true);
    expect(isStaleChunkError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isStaleChunkError(new Error('error loading dynamically imported module'))).toBe(true);
    expect(isStaleChunkError(new Error('Cannot read properties of undefined'))).toBe(false);
  });

  it('reloads once a minute at most', () => {
    const s = mem();
    expect(shouldReload(s, 1_000_000)).toBe(true);
    expect(shouldReload(s, 1_030_000)).toBe(false);
    expect(shouldReload(s, 1_061_000)).toBe(true);
  });

  it('survives blocked storage', () => {
    const s = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
    };
    expect(shouldReload(s)).toBe(true);
  });

  it('reloads straight to the page that failed to open', () => {
    let onError;
    let before;
    const router = {
      onError: (fn) => {
        onError = fn;
      },
      beforeEach: (fn) => {
        before = fn;
      },
      afterEach: () => {},
    };
    const listeners = {};
    const win = {
      sessionStorage: mem(),
      location: { href: 'https://t/projects', assign: vi.fn() },
      addEventListener: (n, fn) => {
        listeners[n] = fn;
      },
    };
    installStaleChunkReload(router, win);
    onError(new TypeError('Failed to fetch dynamically imported module: x.js'), { fullPath: '/projects/BC/board' });
    expect(win.location.assign).toHaveBeenCalledWith('/projects/BC/board');
    onError(new TypeError('Failed to fetch dynamically imported module: x.js'), { fullPath: '/projects/BC/board' });
    expect(win.location.assign).toHaveBeenCalledTimes(1);
    onError(new Error('other'), { fullPath: '/x' });
    expect(win.location.assign).toHaveBeenCalledTimes(1);
    // Vite's own preload error, mid-navigation: reload to where the click was going
    win.sessionStorage = mem();
    before({ fullPath: '/projects/WEB/backlog' });
    const ev = { preventDefault: vi.fn() };
    listeners['vite:preloadError'](ev);
    expect(win.location.assign).toHaveBeenLastCalledWith('/projects/WEB/backlog');
    expect(ev.preventDefault).toHaveBeenCalled();
  });
});
