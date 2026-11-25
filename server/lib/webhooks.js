// Outgoing webhooks: per project (project admins) or workspace-wide (admins).
//
// webhookNotify(c, event) is called after the database batch has committed, next to slackNotify. Delivery runs in the
// background (same pattern as Slack: executionCtx.waitUntil on Workers, a caught promise elsewhere, also pushed to
// c.env.slackQueue in tests). Each delivery is a POST of a JSON body signed with the webhook's secret:
//   X-Tracker-Event: issue.created
//   X-Tracker-Delivery: <uuid> (the delivery's id in the log)
//   X-Tracker-Signature: sha256=<hex HMAC-SHA256 of the raw body>
// The last 50 deliveries per webhook are kept (status, time, error, size, first 2 KB of the body). After 20 failed
// deliveries in a row the webhook is turned off and its creator gets an in-app notification.
import { uuid, now, randomToken } from './crypto.js';
import { fail, publicOrigin } from './http.js';
import { audit } from './audit.js';
import { noticeStmts } from './notifications.js';
import { defer } from './slack.js';
import { parseList } from './json.js';

export const WEBHOOK_EVENTS = [
  'issue.created',
  'issue.updated',
  'issue.deleted',
  'issue.restored',
  'comment.created',
  'sprint.started',
  'sprint.completed',
  'release.released',
];
export const MAX_DELIVERIES = 50;
export const PAYLOAD_KEEP = 2048; // bytes of the body kept for display
export const DISABLE_AFTER = 20; // failures in a row
export const TIMEOUT_MS = 10000;
export const MAX_PER_SCOPE = 10; // webhooks per project, and workspace-wide

// ---- URL checks (no requests to private networks) ----

function ipv4Private(h) {
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null; // not an IPv4 address
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (m.slice(1).some((x) => Number(x) > 255)) return true;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 || // this network, private, loopback, multicast and reserved
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local (cloud metadata)
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && Number(m[3]) === 0) ||
    (a === 198 && (b === 18 || b === 19)) // benchmarking
  );
}

function ipv6Private(h) {
  const x = h.replace(/^\[|\]$/g, '').toLowerCase();
  if (x === '::' || x === '::1') return true;
  if (/^f[cd]/.test(x)) return true; // unique local fc00::/7
  if (/^fe[89ab]/.test(x)) return true; // link-local fe80::/10
  if (/^ff/.test(x)) return true; // multicast
  const mapped = x.match(/^::ffff:(.+)$/); // IPv4-mapped
  if (mapped) {
    const v4 = mapped[1].includes('.')
      ? mapped[1]
      : (() => {
          const [hi, lo] = mapped[1].split(':').map((p) => parseInt(p, 16));
          return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
        })();
    return ipv4Private(v4) !== false;
  }
  return false;
}

/** Why this URL cannot be a webhook target, or null when it can. */
export function webhookUrlError(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    return 'Enter a full URL starting with https://';
  }
  if (u.protocol !== 'https:') return 'The URL must start with https://';
  if (u.username || u.password) return 'Put credentials in a header or the path, not before the host name';
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  if (
    !h ||
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    (!h.includes('.') && !h.startsWith('['))
  ) {
    return 'The URL must point to a public host name, not localhost or a local network name';
  }
  if (h.startsWith('[') ? ipv6Private(h) : ipv4Private(h)) return 'The URL must not point to a private, loopback or link-local address';
  return null;
}

export function checkWebhookUrl(raw) {
  const e = webhookUrlError(raw);
  if (e) fail(400, e);
  return new URL(String(raw).trim()).toString();
}

export const newSecret = () => `whsec_${randomToken(24)}`;

// ---- signing ----

export async function sign(secret, body) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- payloads ----

export const hookEvents = (row) => parseList(row.events).filter((e) => WEBHOOK_EVENTS.includes(e));

const person = (name, email) => (name || email ? { name: name || null, email: email || null } : null);

/**
 * Build the JSON payload for an event reference:
 *   { event, projectId, actorId, issueId?, changes?, commentId?, sprint?, release?, subtasks?, webhookId? }
 * The issue is read as it is now (also from the Trash). Returns null when what it is about is gone.
 */
export async function buildPayload(db, ref, origin) {
  const project = ref.projectId ? await db.get('SELECT key, name FROM projects WHERE id = ?', [ref.projectId]) : null;
  const actor = ref.actorId ? await db.get('SELECT name, email FROM users WHERE id = ?', [ref.actorId]) : null;
  const out = {
    event: ref.event,
    deliveredAt: now(),
    workspaceUrl: origin,
    project: project ? { key: project.key, name: project.name } : null,
    issue: null,
    actor: actor ? person(actor.name, actor.email) : null,
    changes: ref.changes || null,
    comment: null,
  };
  if (ref.issueId) {
    const i = await db.get(
      `SELECT i.key, i.title, i.type, i.priority, i.deleted_at, s.name AS status_name, a.name AS a_name, a.email AS a_email
         FROM issues i JOIN statuses s ON s.id = i.status_id LEFT JOIN users a ON a.id = i.assignee_id WHERE i.id = ?`,
      [ref.issueId],
    );
    if (!i) return null;
    out.issue = {
      key: i.key,
      title: i.title,
      type: i.type,
      status: i.status_name,
      priority: i.priority,
      assignee: person(i.a_name, i.a_email),
      url: `${origin}/browse/${i.key}`,
      ...(ref.event === 'issue.deleted' ? { inTrash: true, subtasks: ref.subtasks || 0 } : {}),
    };
  }
  if (ref.commentId) {
    const cm = await db.get(
      'SELECT cm.id, cm.body, cm.internal, cm.parent_id, cm.created_at, u.name, u.email FROM comments cm LEFT JOIN users u ON u.id = cm.author_id WHERE cm.id = ?',
      [ref.commentId],
    );
    if (!cm) return null;
    out.comment = {
      id: cm.id,
      body: cm.body,
      internal: Boolean(Number(cm.internal)),
      parentId: cm.parent_id || null,
      author: person(cm.name, cm.email),
      createdAt: cm.created_at,
    };
  }
  if (ref.sprint) out.sprint = ref.sprint;
  if (ref.release) out.release = ref.release;
  if (ref.event === 'ping') out.webhook = { id: ref.webhookId };
  return out;
}

// ---- delivery ----

/** POST one body to a webhook and record the result. Returns the delivery record. */
export async function deliverOne(c, hook, ref, payload, { test = false, redeliveryOf = null } = {}) {
  const db = c.env.db;
  const id = uuid();
  const body = JSON.stringify(payload);
  const size = new TextEncoder().encode(body).length;
  const started = Date.now();
  let status = null;
  let error = null;
  const urlErr = webhookUrlError(hook.url); // checked again at delivery time
  if (urlErr) {
    error = urlErr;
  } else {
    const fetchFn = c.env.fetch || fetch;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetchFn(hook.url, {
        method: 'POST',
        redirect: 'manual', // never follow a redirect (it could lead to a private address)
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Opentrack-Webhooks/1',
          'x-tracker-event': payload.event,
          'x-tracker-delivery': id,
          'x-tracker-signature': `sha256=${await sign(hook.signing_secret, body)}`,
        },
        body,
      });
      status = res.status;
      try {
        await res.body?.cancel?.(); // the answer is not read
      } catch {
        // ignore
      }
      if (status < 200 || status >= 300) error = status >= 300 && status < 400 ? 'Redirects are not followed' : `HTTP ${status}`;
    } catch (e) {
      error = ctrl.signal.aborted
        ? `No answer within ${TIMEOUT_MS / 1000} seconds`
        : `Could not connect: ${String(e?.message || e).slice(0, 150)}`;
    } finally {
      clearTimeout(timer);
    }
  }
  const ok = !error;
  const t = now();
  const duration = Date.now() - started;
  const kept =
    size > PAYLOAD_KEEP ? new TextDecoder().decode(new TextEncoder().encode(body).slice(0, PAYLOAD_KEEP)).replace(/�$/, '') : body;
  const stmts = [
    {
      sql: `INSERT INTO webhook_deliveries (id, webhook_id, event, ok, status_code, duration_ms, error, payload_size, payload, ref, test, redelivery_of, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        id,
        hook.id,
        payload.event,
        ok ? 1 : 0,
        status,
        duration,
        error,
        size,
        kept,
        JSON.stringify(ref),
        test ? 1 : 0,
        redeliveryOf,
        t,
      ],
    },
    {
      sql: `DELETE FROM webhook_deliveries WHERE webhook_id = ? AND id NOT IN (SELECT id FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT ${MAX_DELIVERIES})`,
      params: [hook.id, hook.id],
    },
  ];
  // test deliveries do not count towards turning the webhook off
  if (!test) {
    stmts.push(
      ok
        ? { sql: 'UPDATE webhooks SET failure_count = 0, last_delivery_at = ?, last_status = ? WHERE id = ?', params: [t, status, hook.id] }
        : {
            sql: 'UPDATE webhooks SET failure_count = failure_count + 1, last_delivery_at = ?, last_status = ? WHERE id = ?',
            params: [t, status, hook.id],
          },
    );
  } else {
    stmts.push({ sql: 'UPDATE webhooks SET last_delivery_at = ?, last_status = ? WHERE id = ?', params: [t, status, hook.id] });
  }
  await db.batch(stmts);
  if (!ok && !test) await maybeDisable(db, hook);
  return { id, ok, status, error, duration, size };
}

async function maybeDisable(db, hook) {
  const row = await db.get('SELECT failure_count, active, created_by, url, project_id FROM webhooks WHERE id = ?', [hook.id]);
  if (!row || !Number(row.active) || Number(row.failure_count) < DISABLE_AFTER) return;
  const reason = `Turned off after ${DISABLE_AFTER} failed deliveries in a row`;
  const r = await db.run('UPDATE webhooks SET active = 0, disabled_reason = ?, updated_at = ? WHERE id = ? AND active = 1', [
    reason,
    now(),
    hook.id,
  ]);
  if (!r.changes) return;
  const host = (() => {
    try {
      return new URL(row.url).hostname;
    } catch {
      return 'its URL';
    }
  })();
  const project = row.project_id ? await db.get('SELECT key FROM projects WHERE id = ?', [row.project_id]) : null;
  const where = project ? `${project.key} project settings > Webhooks` : 'Admin > Webhooks';
  const stmts = [audit(null, 'webhook.auto_disabled', 'webhook', hook.id, { host, failures: Number(row.failure_count) })];
  const creator = row.created_by ? await db.get(`SELECT id FROM users WHERE id = ? AND status = 'active'`, [row.created_by]) : null;
  if (creator) {
    stmts.push(
      ...noticeStmts([
        {
          userId: creator.id,
          type: 'webhook',
          message: `Your webhook to ${host} was turned off after ${DISABLE_AFTER} failed deliveries in a row. Check it and turn it on again in ${where}.`,
        },
      ]),
    );
  }
  await db.batch(stmts);
}

/** Active webhooks that want this event: the project's and the workspace-wide ones. */
async function hooksFor(db, ref) {
  const rows = await db.all(
    `SELECT * FROM webhooks WHERE active = 1 AND (project_id IS NULL${ref.projectId ? ' OR project_id = ?' : ''})`,
    ref.projectId ? [ref.projectId] : [],
  );
  return rows.filter((h) => hookEvents(h).includes(ref.event) && (!ref.internal || Number(h.include_internal)));
}

async function deliverAll(c, ref) {
  const db = c.env.db;
  const hooks = await hooksFor(db, ref);
  if (!hooks.length) return;
  const payload = await buildPayload(db, ref, publicOrigin(c));
  if (!payload) return;
  await Promise.all(hooks.map((h) => deliverOne(c, h, ref, payload).catch((e) => console.error('webhook delivery failed', e))));
}

/**
 * Send an event to the matching webhooks, in the background. Call after the database batch has committed.
 * event: { event, projectId?, issueId?, changes?, commentId?, internal?, sprint?, release?, subtasks? }
 */
export function webhookNotify(c, event) {
  try {
    const actor = c.get('user');
    const ref = { ...event, actorId: actor?.id || null };
    defer(
      c,
      (async () => {
        if (!ref.projectId && ref.issueId) {
          const i = await c.env.db.get('SELECT project_id FROM issues WHERE id = ?', [ref.issueId]);
          if (!i) return;
          ref.projectId = i.project_id;
        }
        await deliverAll(c, ref);
      })(),
    );
  } catch (e) {
    console.error('webhooks: could not schedule', e);
  }
}

/** History rows [field, old, new] as the `changes` list of issue.updated. */
export function changeList(history) {
  return history.map(([field, from, to]) => ({ field, from: from ?? null, to: to ?? null }));
}
