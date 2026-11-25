import { HTTPException } from 'hono/http-exception';
import { validDate } from './time.js';

export class ApiError extends HTTPException {
  constructor(status, message, extra) {
    super(status, { message });
    this.extra = extra;
  }
}

export const fail = (status, message, extra) => {
  throw new ApiError(status, message, extra);
};

export async function body(c) {
  try {
    const b = await c.req.json();
    return b && typeof b === 'object' ? b : {};
  } catch {
    return {};
  }
}

/** Read a string field: trims, enforces max length, optional required. */
export function str(v, { max = 500, required = false, name = 'value' } = {}) {
  if (v === undefined || v === null) {
    if (required) fail(400, `${name} is required`);
    return v === null ? null : undefined;
  }
  if (typeof v !== 'string') fail(400, `${name} must be text`);
  const t = v.trim();
  if (required && !t) fail(400, `${name} is required`);
  if (t.length > max) fail(400, `${name} is too long (max ${max} characters)`);
  return t;
}

export function oneOf(v, list, name) {
  if (v === undefined) return undefined;
  if (!list.includes(v)) fail(400, `${name} must be one of: ${list.join(', ')}`);
  return v;
}

export function num(v, { name = 'value', min = -1e9, max = 1e9 } = {}) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) fail(400, `${name} must be a number between ${min} and ${max}`);
  return n;
}

/** A date field: undefined stays undefined, null or '' is null, else a real calendar day as YYYY-MM-DD (400 otherwise). */
export function isoDate(v, name = 'date') {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) fail(400, `${name} must be YYYY-MM-DD`);
  if (!validDate(v)) fail(400, `${name} is not a real date`);
  return v;
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A stand-in for the request context where there is no request (jobs): the notify helpers (Slack, webhooks, email)
 * read env, the acting user and the site origin from it. Their background deliveries collect in `pending`, so the
 * caller can await them before it finishes.
 */
export function detachedContext(env, user, origin) {
  const pending = [];
  return {
    env: { ...env, PUBLIC_URL: env.PUBLIC_URL || origin, slackQueue: pending, emailQueue: pending },
    get: (k) => (k === 'user' ? user : undefined),
    req: { url: origin },
    pending,
  };
}

/**
 * Run work in the background without holding up the response: executionCtx.waitUntil on Workers, a caught promise on
 * Node and in tests. opts.queue: an array that also collects the promise (tests and jobs await it). opts.label: the
 * console text when the work fails.
 */
export function defer(c, promise, { label = 'background work failed', queue = null } = {}) {
  const p = promise.catch((e) => console.error(label, e));
  if (Array.isArray(queue)) queue.push(p);
  let ctx = null;
  try {
    ctx = c.executionCtx; // Hono throws when the host gave no execution context (Node, tests)
  } catch {
    ctx = null;
  }
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
}

/** The site's base URL (PUBLIC_URL, else the request's origin), without a trailing slash. */
export function publicOrigin(c) {
  return (c.env.PUBLIC_URL || new URL(c.req.url).origin).replace(/\/$/, '');
}
