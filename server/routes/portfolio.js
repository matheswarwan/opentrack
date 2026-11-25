// Portfolio (server/lib/portfolio.js): every visible project's health and numbers in one response.
//   GET /api/portfolio?archived=1   rows, summary tiles, milestones in the next 90 days (archived projects only with archived=1)
// Filters (lead, health, My projects, search) and sorting run in the browser (src/portfolio.js) on these rows.
import { portfolio } from '../lib/portfolio.js';
import { clock } from '../lib/time.js';

export function registerPortfolio(app) {
  app.get('/api/portfolio', async (c) => {
    const out = await portfolio(c.env.db, c.get('user'), { archived: c.req.query('archived') === '1', nowMs: clock(c.env) });
    return c.json(out);
  });
}
