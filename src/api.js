import { reactive } from 'vue';
import { recordFailedRequest } from './diagnostics.js';

export const session = reactive({
  loaded: false,
  user: null,
  appName: 'Opentrack',
  canCreateProject: false,
  unread: 0,
  // an admin who must turn on two-factor sign-in before anything else (the router keeps them on Profile)
  twoFactorRequired: false,
  // the public demo account (server/lib/demo.js): admin pages are read-only
  demo: false,
});

// A sign-in waiting for its two-factor code: { token } from the password step or an invite link (LoginView asks for the code).
export const pendingSignIn = reactive({ token: '' });

export const toasts = reactive([]);
export function toast(message, kind = 'ok') {
  const t = { id: Math.random(), message, kind };
  toasts.push(t);
  setTimeout(() => toasts.splice(toasts.indexOf(t), 1), kind === 'error' || kind === 'warn' ? 6000 : 3000);
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

// opts.background: a request the page makes on a timer. It does not count as using the session (idle timeout).
export async function api(method, path, body, opts = {}) {
  const headers = { 'x-requested-with': 'opentrack' };
  if (opts.background) headers['x-background'] = '1';
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  if (res.status === 401 && !path.startsWith('/api/auth/') && session.loaded) {
    session.user = null;
    onUnauthorized();
  }
  if (!res.ok) {
    if (res.status !== 401) recordFailedRequest(method, path, res.status, data && data.error);
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data && typeof data === 'object' ? data : null; // e.g. workflow rules: { code, missing, allowed }
    throw err;
  }
  return data;
}

export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
export const patch = (p, b = {}) => api('PATCH', p, b);
export const put = (p, b = {}) => api('PUT', p, b);
export const del = (p) => api('DELETE', p);

export async function loadMe() {
  try {
    const me = await get('/api/me');
    session.user = me.user;
    session.appName = me.appName;
    session.canCreateProject = me.canCreateProject;
    session.unread = me.unreadNotifications;
    session.twoFactorRequired = Boolean(me.twoFactorRequired);
    session.demo = Boolean(me.demo);
  } catch {
    session.user = null;
  }
  session.loaded = true;
  document.title = session.appName;
}

// cached active users for pickers
let usersPromise = null;
export function users(refresh = false) {
  if (!usersPromise || refresh)
    usersPromise = get('/api/users')
      .then((r) => r.users)
      .catch((e) => {
        usersPromise = null;
        throw e;
      });
  return usersPromise;
}

export function qs(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    p.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  return p.toString();
}
