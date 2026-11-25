// Outgoing webhooks: Project settings > Webhooks (project admins) and Admin > Webhooks (workspace-wide, admins).
// Delivery and signing: server/lib/webhooks.js. The signing secret is returned once, by the create call, and never again.
import { body, fail, str } from '../lib/http.js';
import { uuid, now } from '../lib/crypto.js';
import { requireAdmin } from '../lib/session.js';
import { audit } from '../lib/audit.js';
import { projectAccess } from '../lib/access.js';
import { WEBHOOK_EVENTS, MAX_PER_SCOPE, checkWebhookUrl, newSecret, hookEvents, buildPayload, deliverOne } from '../lib/webhooks.js';
import { publicOrigin } from '../lib/http.js';
import { parseJson } from '../lib/json.js';

const host = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

function hookOut(h, project = null) {
  return {
    id: h.id,
    scope: h.project_id ? 'project' : 'workspace',
    projectKey: project?.key || null,
    name: h.name || null,
    url: h.url,
    events: hookEvents(h),
    includeInternal: Boolean(Number(h.include_internal)),
    active: Boolean(Number(h.active)),
    disabledReason: h.disabled_reason || null,
    failureCount: Number(h.failure_count) || 0,
    secretLast4: h.signing_secret ? h.signing_secret.slice(-4) : null,
    createdBy: h.creator_name ? { name: h.creator_name } : null,
    createdAt: h.created_at,
    updatedAt: h.updated_at,
    lastDeliveryAt: h.last_delivery_at || null,
    lastStatus: h.last_status ?? null,
  };
}

function deliveryOut(d) {
  return {
    id: d.id,
    event: d.event,
    ok: Boolean(Number(d.ok)),
    statusCode: d.status_code ?? null,
    durationMs: d.duration_ms ?? null,
    error: d.error || null,
    payloadSize: Number(d.payload_size) || 0,
    payload: d.payload || '',
    payloadCut: Number(d.payload_size) > (d.payload || '').length,
    test: Boolean(Number(d.test)),
    redeliveryOf: d.redelivery_of || null,
    createdAt: d.created_at,
  };
}

/** Webhooks are a way to send data out of the workspace, so only people in the web app manage them (no API tokens). */
function requireSession(c) {
  if (c.get('authVia') === 'token') fail(403, 'Webhooks can only be managed in the web app, not with an API token');
}

const HOOK_SELECT = 'SELECT w.*, u.name AS creator_name FROM webhooks w LEFT JOIN users u ON u.id = w.created_by';

/** Load a webhook and check the caller may manage it (admins for workspace-wide ones, project admins otherwise). */
async function loadHook(c) {
  requireSession(c);
  const h = await c.env.db.get(`${HOOK_SELECT} WHERE w.id = ?`, [c.req.param('id')]);
  if (!h) fail(404, 'Webhook not found');
  let project = null;
  if (h.project_id) {
    try {
      project = (await projectAccess(c, h.project_id, 'admin')).project;
    } catch (e) {
      if (e?.status === 403) fail(404, 'Webhook not found');
      throw e;
    }
  } else if (c.get('user').role !== 'admin') {
    fail(404, 'Webhook not found');
  }
  return { h, project };
}

function readEvents(v, required) {
  if (v === undefined && !required) return undefined;
  if (!Array.isArray(v)) fail(400, 'events must be a list');
  const list = [...new Set(v.filter((e) => WEBHOOK_EVENTS.includes(e)))];
  if (v.some((e) => !WEBHOOK_EVENTS.includes(e))) fail(400, `Unknown event. Events: ${WEBHOOK_EVENTS.join(', ')}`);
  if (!list.length) fail(400, 'Choose at least one event');
  return list;
}

async function listHooks(db, projectId) {
  return db.all(
    `${HOOK_SELECT} WHERE ${projectId ? 'w.project_id = ?' : 'w.project_id IS NULL'} ORDER BY w.created_at`,
    projectId ? [projectId] : [],
  );
}

async function createHook(c, project) {
  const db = c.env.db;
  const user = c.get('user');
  const b = await body(c);
  const url = checkWebhookUrl(str(b.url, { required: true, max: 2000, name: 'URL' }));
  const events = readEvents(b.events, true);
  const name = str(b.name, { max: 100, name: 'Name' }) || null;
  const n = await db.get(
    `SELECT CAST(COUNT(*) AS INTEGER) AS n FROM webhooks WHERE ${project ? 'project_id = ?' : 'project_id IS NULL'}`,
    project ? [project.id] : [],
  );
  if (Number(n?.n) >= MAX_PER_SCOPE) fail(400, `At most ${MAX_PER_SCOPE} webhooks ${project ? 'per project' : 'for the workspace'}`);
  const id = uuid();
  const secret = newSecret();
  const t = now();
  await db.batch([
    {
      sql: `INSERT INTO webhooks (id, project_id, name, url, events, include_internal, active, signing_secret, failure_count, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?, ?)`,
      params: [id, project?.id || null, name, url, JSON.stringify(events), b.includeInternal ? 1 : 0, secret, user.id, t, t],
    },
    // the URL can hold a token (some services put one in the path), so the audit log keeps only the host
    audit(user.id, 'webhook.created', project ? 'project' : 'webhook', project ? project.id : id, {
      webhookId: id,
      host: host(url),
      events,
    }),
  ]);
  const h = await db.get(`${HOOK_SELECT} WHERE w.id = ?`, [id]);
  return c.json({ webhook: hookOut(h, project), secret }, 201);
}

export function registerWebhooks(app) {
  // ---- workspace-wide (admins) ----
  app.get('/api/admin/webhooks', async (c) => {
    requireAdmin(c);
    return c.json({ webhooks: (await listHooks(c.env.db, null)).map((h) => hookOut(h)), events: WEBHOOK_EVENTS });
  });
  app.post('/api/admin/webhooks', async (c) => {
    requireAdmin(c);
    return createHook(c, null);
  });

  // ---- per project (project admins) ----
  app.get('/api/projects/:key/webhooks', async (c) => {
    requireSession(c);
    const { project } = await projectAccess(c, c.req.param('key'), 'admin');
    return c.json({ webhooks: (await listHooks(c.env.db, project.id)).map((h) => hookOut(h, project)), events: WEBHOOK_EVENTS });
  });
  app.post('/api/projects/:key/webhooks', async (c) => {
    requireSession(c);
    const { project } = await projectAccess(c, c.req.param('key'), 'admin');
    return createHook(c, project);
  });

  // ---- one webhook ----
  app.patch('/api/webhooks/:id', async (c) => {
    const { h, project } = await loadHook(c);
    const db = c.env.db;
    const b = await body(c);
    const sets = [];
    const params = [];
    const set = (col, v) => {
      sets.push(`${col} = ?`);
      params.push(v);
    };
    if (b.url !== undefined) set('url', checkWebhookUrl(str(b.url, { required: true, max: 2000, name: 'URL' })));
    const events = readEvents(b.events, false);
    if (events) set('events', JSON.stringify(events));
    if (b.name !== undefined) set('name', str(b.name, { max: 100, name: 'Name' }) || null);
    if (b.includeInternal !== undefined) set('include_internal', b.includeInternal ? 1 : 0);
    if (b.active !== undefined) {
      if (typeof b.active !== 'boolean') fail(400, 'active must be true or false');
      set('active', b.active ? 1 : 0);
      if (b.active) {
        set('failure_count', 0); // turning it on again starts the count afresh
        set('disabled_reason', null);
      }
    }
    if (!sets.length) fail(400, 'Nothing to change');
    set('updated_at', now());
    await db.batch([
      { sql: `UPDATE webhooks SET ${sets.join(', ')} WHERE id = ?`, params: [...params, h.id] },
      audit(c.get('user').id, 'webhook.updated', project ? 'project' : 'webhook', project ? project.id : h.id, {
        webhookId: h.id,
        host: host(b.url ?? h.url),
        ...(events ? { events } : {}),
        ...(b.active !== undefined ? { active: b.active } : {}),
      }),
    ]);
    return c.json({ webhook: hookOut(await db.get(`${HOOK_SELECT} WHERE w.id = ?`, [h.id]), project) });
  });

  app.delete('/api/webhooks/:id', async (c) => {
    const { h, project } = await loadHook(c);
    await c.env.db.batch([
      { sql: 'DELETE FROM webhook_deliveries WHERE webhook_id = ?', params: [h.id] },
      { sql: 'DELETE FROM webhooks WHERE id = ?', params: [h.id] },
      audit(c.get('user').id, 'webhook.deleted', project ? 'project' : 'webhook', project ? project.id : h.id, {
        webhookId: h.id,
        host: host(h.url),
      }),
    ]);
    return c.json({ ok: true });
  });

  app.get('/api/webhooks/:id/deliveries', async (c) => {
    const { h } = await loadHook(c);
    const rows = await c.env.db.all('SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT 50', [h.id]);
    return c.json({ deliveries: rows.map(deliveryOut) });
  });

  // Send test: a `ping` event, sent now; the answer says how it went. Does not count towards turning the webhook off.
  app.post('/api/webhooks/:id/test', async (c) => {
    const { h } = await loadHook(c);
    const ref = { event: 'ping', projectId: h.project_id || null, actorId: c.get('user').id, webhookId: h.id };
    const payload = await buildPayload(c.env.db, ref, publicOrigin(c));
    const r = await deliverOne(c, h, ref, payload, { test: true });
    return c.json({ delivery: r });
  });

  // Redeliver: the same event again, built from the issue as it is now (the full body is not stored), with a new delivery id.
  app.post('/api/webhooks/:id/deliveries/:did/redeliver', async (c) => {
    const { h } = await loadHook(c);
    const db = c.env.db;
    const d = await db.get('SELECT * FROM webhook_deliveries WHERE id = ? AND webhook_id = ?', [c.req.param('did'), h.id]);
    if (!d) fail(404, 'Delivery not found');
    const ref = parseJson(d.ref);
    if (!ref?.event) fail(400, 'This delivery cannot be sent again');
    const payload = await buildPayload(db, ref, publicOrigin(c));
    if (!payload) fail(410, 'What this event was about no longer exists (the issue or comment was deleted for good)');
    const r = await deliverOne(c, h, ref, payload, { test: Boolean(Number(d.test)), redeliveryOf: d.id });
    return c.json({ delivery: r });
  });
}
