// Cloudflare Workers entry: API on /api and /auth, everything else from the built front end.
import { createApp } from './app.js';
import { d1Adapter } from './db/adapters.js';

const app = createApp();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (
      url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/auth/') ||
      url.pathname === '/mcp' ||
      url.pathname.startsWith('/oauth/') ||
      url.pathname.startsWith('/.well-known/') ||
      url.pathname.startsWith('/feeds/') ||
      url.pathname.startsWith('/slack/')
    ) {
      return app.fetch(request, { ...env, db: d1Adapter(env.DB) }, ctx);
    }
    // SPA: static file if it exists, else index.html (wrangler.toml not_found_handling)
    return env.ASSETS.fetch(request);
  },
};
