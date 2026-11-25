// Recent client-side problems, sent with feedback when the person opts in to technical details.
const MAX = 10;
export const recentErrors = [];
export const recentFailedRequests = [];

function push(list, item) {
  list.push({ at: new Date().toISOString(), ...item });
  if (list.length > MAX) list.shift();
}

export function recordFailedRequest(method, path, status, message) {
  // drop query strings: they can hold search text
  push(recentFailedRequests, { method, path: String(path).split('?')[0], status, message: String(message || '').slice(0, 200) });
}

export function installErrorCapture() {
  window.addEventListener('error', (e) =>
    push(recentErrors, {
      message: String(e.message || e.error || 'error').slice(0, 300),
      source: e.filename ? `${e.filename.split('/').pop()}:${e.lineno}` : undefined,
    }),
  );
  window.addEventListener('unhandledrejection', (e) =>
    push(recentErrors, { message: String(e.reason?.message || e.reason || 'unhandled rejection').slice(0, 300) }),
  );
}
