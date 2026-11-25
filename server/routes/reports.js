// Project reports: GET /api/projects/:key/reports (the engine is server/lib/reports.js).
import { projectAccess } from '../lib/access.js';
import { projectReports } from '../lib/reports.js';

export function registerReports(app) {
  app.get('/api/projects/:key/reports', async (c) => {
    const { project } = await projectAccess(c, c.req.param('key'));
    return c.json(await projectReports(c.env.db, project, { sprint: c.req.query('sprint'), weeks: c.req.query('weeks') }));
  });
}
