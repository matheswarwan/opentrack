// Smoke test: every page of the web app sets up and renders its first (loading) state without an error.
// Requests never answer here, so this checks the setup code and the template of each view, not its data.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createSSRApp, h, ref } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createRouter, createMemoryHistory } from 'vue-router';
import { session } from '../src/api.js';

const views = import.meta.glob(['../src/views/**/*.vue', '../src/App.vue']);
const PROJECT = {
  id: 'p1',
  key: 'WEB',
  name: 'Website',
  canEdit: true,
  canAdmin: true,
  canCreate: true,
  canSprints: true,
  visibility: 'open',
  leadId: 'u1',
  archived: false,
  statuses: [
    { id: 's1', name: 'To Do', category: 'todo' },
    { id: 's2', name: 'Done', category: 'done' },
  ],
  sprints: [],
  members: [],
  fields: [],
  components: [],
  releases: [],
  permissions: {},
  workflow: { transitions: null, adminBypass: false, required: {} },
};

beforeAll(() => {
  session.loaded = true;
  session.user = { id: 'u1', name: 'Ann Lee', email: 'ann@example.com', role: 'admin', hasPassword: true };
  session.canCreateProject = true;
  vi.stubGlobal('fetch', () => new Promise(() => {})); // never answers
  vi.stubGlobal('location', { origin: 'https://tracker.example', href: 'https://tracker.example/', pathname: '/', search: '' });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false }),
    location: globalThis.location,
  });
  vi.stubGlobal('document', { title: '', addEventListener() {}, removeEventListener() {}, querySelector: () => null });
});
afterAll(() => {
  vi.unstubAllGlobals();
  session.user = null;
});

async function render(load, path) {
  const component = (await load()).default;
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/:all(.*)*', name: 'page', component: { render: () => null } },
      { path: '/projects/:key/:tab/:id?', name: 'project', component: { render: () => null } },
    ],
  });
  await router.push(path);
  await router.isReady();
  const errors = [];
  const app = createSSRApp({ render: () => h(component) });
  app.use(router);
  app.provide('project', ref(PROJECT));
  app.provide('reloadProject', async () => {});
  app.config.errorHandler = (e) => errors.push(e);
  app.config.warnHandler = (msg) => {
    if (/Property .* was accessed during render but is not defined|Failed to resolve component|Unhandled error/.test(msg))
      errors.push(new Error(msg));
  };
  const html = await renderToString(app);
  return { html, errors };
}

describe('every view renders its first state', () => {
  const names = Object.keys(views).sort();
  it('finds the views', () => {
    expect(names.length).toBeGreaterThan(40);
  });
  for (const name of names) {
    it(name.replace('../src/', ''), async () => {
      const path = name.includes('/views/project/') ? '/projects/WEB/board/r1' : '/somewhere/WEB-1';
      const { html, errors } = await render(views[name], path);
      expect(errors.map((e) => e.message)).toEqual([]);
      expect(typeof html).toBe('string');
    });
  }
});
