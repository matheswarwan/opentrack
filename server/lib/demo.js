// Public demo (env DEMO_MODE=true). The sign-in page offers "Explore the demo", which signs the visitor in as one
// shared demo account (POST /api/auth/demo). The account has the admin role, so every page works and Admin can be
// browsed, but it is read-only wherever a change would alter the workspace for everyone or lock other visitors out:
//   - every admin action (requireAdmin) accepts reads only;
//   - the demo account's own profile, password, two-factor, sessions and avatar cannot be changed;
//   - outgoing webhooks cannot be created, changed or fired (they would send requests to any URL).
// Everything else (projects, issues, boards, sprints, reports, time, comments) works as for any member.

export const DEMO_EMAIL = 'demo@opentrack.demo';
export const DEMO_NAME = 'Demo visitor';
export const DEMO_READ_ONLY = 'This is a read-only demo: you can look at this, but not change it.';

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Paths the demo account may read but never write (besides requireAdmin actions). */
const LOCKED = [
  /^\/api\/me$/,
  /^\/api\/me\/password$/,
  /^\/api\/me\/2fa(\/|$)/,
  /^\/api\/me\/sessions(\/|$)/,
  /^\/api\/me\/avatar$/,
  /^\/api\/(admin|projects\/[^/]+)\/webhooks$/,
  /^\/api\/webhooks\//,
];

export function demoEnabled(env) {
  return /^(1|true|yes|on)$/i.test(String(env?.DEMO_MODE ?? '').trim());
}

export function isDemoUser(env, user) {
  return Boolean(user && demoEnabled(env) && user.email === DEMO_EMAIL);
}

export const isWrite = (c) => !READS.has(c.req.method);

/** A write the demo account may not make outside requireAdmin. */
export function demoLocked(c) {
  return isWrite(c) && LOCKED.some((re) => re.test(c.req.path));
}
