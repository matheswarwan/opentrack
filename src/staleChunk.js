// After a deploy the old page bundles are gone, so a tab opened earlier fails to
// load the next page ("Failed to fetch dynamically imported module") and the
// click seems to do nothing. Reload once, straight to the page that was asked for.
// A second failure within a minute is left alone so a real outage cannot loop.

const KEY = 'apt_chunk_reload';
const WINDOW_MS = 60_000;

export function isStaleChunkError(err) {
  const msg = String((err && err.message) || err || '');
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(
    msg,
  );
}

export function shouldReload(storage, now = Date.now()) {
  let last = 0;
  try {
    last = Number(storage.getItem(KEY)) || 0;
  } catch {
    /* storage blocked */
  }
  if (now - last < WINDOW_MS) return false;
  try {
    storage.setItem(KEY, String(now));
  } catch {
    /* storage blocked */
  }
  return true;
}

export function installStaleChunkReload(router, win = window) {
  // Vite reports a failed page bundle before the router does, while the URL still
  // shows the old page, so remember where the click was going.
  let pending = null;
  router.beforeEach((to) => {
    pending = to.fullPath;
  });
  router.afterEach(() => {
    pending = null;
  });
  const reloadTo = (path) => {
    if (!shouldReload(win.sessionStorage)) return false;
    win.location.assign(path || win.location.href);
    return true;
  };
  router.onError((err, to) => {
    if (isStaleChunkError(err)) reloadTo(to && to.fullPath);
  });
  win.addEventListener('vite:preloadError', (event) => {
    if (reloadTo(pending)) event.preventDefault();
  });
}
