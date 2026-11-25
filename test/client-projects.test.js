// Client project store (src/projects.js): cached promises, refresh, expiry and invalidation.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { projectList, project, forgetProjects } from '../src/projects.js';
import { projectsChanged, ui } from '../src/ui.js';

let calls;
let fail;
const realFetch = globalThis.fetch;
beforeEach(() => {
  calls = [];
  fail = false;
  forgetProjects();
  globalThis.fetch = async (path) => {
    calls.push(path);
    if (fail) return new Response(JSON.stringify({ error: 'Offline' }), { status: 500, headers: { 'content-type': 'application/json' } });
    const body =
      path === '/api/projects'
        ? { projects: [{ key: 'WEB' }, { key: 'APP' }] }
        : { project: { key: path.split('/').pop().toUpperCase(), statuses: [], n: calls.length } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

describe('projectList', () => {
  it('fetches once for callers at the same time and later ones', async () => {
    const [a, b] = await Promise.all([projectList(), projectList()]);
    expect(a).toEqual([{ key: 'WEB' }, { key: 'APP' }]);
    expect(b).toBe(a);
    await projectList();
    expect(calls).toEqual(['/api/projects']);
  });
  it('refresh fetches again', async () => {
    await projectList();
    await projectList(true);
    expect(calls.length).toBe(2);
  });
  it('a failure is not cached', async () => {
    fail = true;
    await expect(projectList()).rejects.toThrow('Offline');
    fail = false;
    expect((await projectList()).length).toBe(2);
    expect(calls.length).toBe(2);
  });
  it('projectsChanged() invalidates and bumps the counter the sidebar watches', async () => {
    await projectList();
    await project('WEB');
    const before = ui.projects;
    projectsChanged();
    expect(ui.projects).toBe(before + 1);
    await projectList();
    await project('WEB');
    expect(calls).toEqual(['/api/projects', '/api/projects/WEB', '/api/projects', '/api/projects/WEB']);
  });
});

describe('project', () => {
  it('caches per key, whatever the case of the key', async () => {
    const a = await project('WEB');
    const b = await project('web');
    await project('APP');
    expect(b).toBe(a);
    expect(calls).toEqual(['/api/projects/WEB', '/api/projects/APP']);
  });
  it('refresh replaces the cached payload for later callers', async () => {
    const a = await project('WEB');
    const b = await project('WEB', true);
    expect(b).not.toBe(a);
    expect(await project('WEB')).toBe(b);
    expect(calls.length).toBe(2);
  });
  it('a failure is not cached', async () => {
    fail = true;
    await expect(project('WEB')).rejects.toThrow('Offline');
    fail = false;
    expect((await project('WEB')).key).toBe('WEB');
  });
  it('an answer older than a minute is fetched again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-20T10:00:00Z'));
    await project('WEB');
    vi.setSystemTime(new Date('2026-11-20T10:00:59Z'));
    await project('WEB');
    expect(calls.length).toBe(1);
    vi.setSystemTime(new Date('2026-11-20T10:01:01Z'));
    await project('WEB');
    expect(calls.length).toBe(2);
  });
  it('forgetProjects(key) drops the list and that project only', async () => {
    await project('WEB');
    await project('APP');
    await projectList();
    forgetProjects('web');
    await project('WEB');
    await project('APP');
    await projectList();
    expect(calls).toEqual(['/api/projects/WEB', '/api/projects/APP', '/api/projects', '/api/projects/WEB', '/api/projects']);
  });
});
