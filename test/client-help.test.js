// Help page: one component per section (src/views/help/), listed in sections.js and shown by HelpView.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createRouter, createMemoryHistory } from 'vue-router';
import { session } from '../src/api.js';
import { FAQ } from '../src/views/help/faq.js';

let SECTIONS;
let HelpView;
beforeAll(async () => {
  vi.stubGlobal('location', { origin: 'https://tracker.example' });
  session.loaded = true;
  ({ SECTIONS } = await import('../src/views/help/sections.js'));
  HelpView = (await import('../src/views/HelpView.vue')).default;
});
afterAll(() => {
  vi.unstubAllGlobals();
  session.user = null;
});

async function renderAs(role) {
  session.user = { id: 'u1', name: 'Ann Lee', role };
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:all(.*)*', component: { render: () => null } }] });
  await router.push('/help');
  await router.isReady();
  const errors = [];
  const app = createSSRApp({ render: () => h(HelpView) });
  app.use(router);
  app.config.errorHandler = (e) => errors.push(e.message);
  app.config.warnHandler = (msg) => errors.push(msg);
  const html = await renderToString(app);
  expect(errors).toEqual([]);
  return html;
}
const sectionIds = (html) => [...html.matchAll(/<section id="([a-z-]+)"/g)].map((m) => m[1]);

describe('help sections', () => {
  it('every section has an id of its own, a title, an audience and a component', () => {
    expect(SECTIONS.length).toBe(26);
    expect(new Set(SECTIONS.map((s) => s.id)).size).toBe(SECTIONS.length);
    for (const s of SECTIONS) {
      expect(s.title).toBeTruthy();
      expect(['everyone', 'writers', 'staff', 'project-admins', 'admins']).toContain(s.for);
      expect(s.component, s.id).toBeTruthy();
    }
    expect(new Set(SECTIONS.map((s) => s.component)).size).toBe(SECTIONS.length);
  });
  it('an admin sees every section, in order, each with its anchor and text', async () => {
    const html = await renderAs('admin');
    expect(sectionIds(html)).toEqual(SECTIONS.map((s) => s.id));
    for (const s of SECTIONS) expect(html).toContain(`href="#${s.id}"`);
    expect(html).toContain('https://tracker.example/mcp');
    expect(html).toContain('Opentrack is where your team plans and tracks work');
    expect(html).toContain(FAQ[0].items[0].q);
    expect(html).toContain('X-Tracker-Signature');
  });
  it('a guest sees only the sections for everyone', async () => {
    const html = await renderAs('guest');
    expect(sectionIds(html)).toEqual(SECTIONS.filter((s) => s.for === 'everyone').map((s) => s.id));
  });
  it('a viewer also sees the staff sections, not the ones for writers or admins', async () => {
    const html = await renderAs('viewer');
    expect(sectionIds(html)).toEqual(SECTIONS.filter((s) => s.for === 'everyone' || s.for === 'staff').map((s) => s.id));
  });
});
