// Jira import: the Jira Cloud REST client (basic auth, counted fetches, errors with a plain message).
import { toBase64 } from '../files.js';

export class JiraError extends Error {
  constructor(status, message, retryAfter) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function jiraMessage(res) {
  try {
    const b = await res.json();
    const parts = [...(b.errorMessages || []), ...Object.values(b.errors || {})].filter(Boolean);
    if (parts.length) return parts.join('; ');
    if (b.message) return b.message;
  } catch {
    // not JSON
  }
  return `Jira answered ${res.status}`;
}

/** Calls to one Jira site with Basic auth (email + API token). `used.fetches` counts every call. */
export function jiraClient({ fetch: fetchFn, site, email, token, used }) {
  const auth = `Basic ${toBase64(new TextEncoder().encode(`${email}:${token}`))}`;
  async function call(path, { method = 'GET', body, raw = false } = {}) {
    if (used) used.fetches += 1;
    let res;
    try {
      res = await fetchFn(`${site}${path}`, {
        method,
        headers: { authorization: auth, accept: raw ? '*/*' : 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new JiraError(0, `Could not reach Jira: ${e?.message || e}`);
    }
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'));
      throw new JiraError(429, 'Jira asked to slow down (rate limit)', Number.isFinite(ra) && ra >= 0 ? ra : 30);
    }
    if (!res.ok) {
      const msg = res.status === 401 ? 'Jira did not accept the email and API token' : await jiraMessage(res);
      throw new JiraError(res.status, msg);
    }
    if (raw) return res;
    return res.json();
  }
  return {
    get: (path) => call(path),
    post: (path, body) => call(path, { method: 'POST', body }),
    raw: (path) => call(path, { raw: true }),
  };
}

export const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();

/** Every project the account can see (GET /rest/api/3/project/search, paginated). */
export async function listJiraProjects(jira) {
  const out = [];
  let startAt = 0;
  for (let page = 0; page < 40; page++) {
    const r = await jira.get(`/rest/api/3/project/search?${qs({ startAt, maxResults: 50, orderBy: 'key' })}`);
    for (const p of r.values || []) out.push({ id: String(p.id), key: p.key, name: p.name });
    if (r.isLast || !(r.values || []).length) break;
    startAt += r.values.length;
  }
  return out;
}
