// Project store: the project list and each project's payload as cached promises (the pattern of users()
// in api.js), so the sidebar, a view and the issue drawer on one page share one request each.
//
// An answer is reused for MAX_AGE; after that the next caller fetches again, so a change made by someone
// else shows up without a page reload. Changes made here invalidate at once: projectsChanged() (ui.js)
// calls forgetProjects(), and the project layout reloads its project with refresh = true.
import { get } from './api.js';

const MAX_AGE = 60 * 1000;
const fresh = (entry) => entry && Date.now() - entry.at < MAX_AGE;

let list = null; // { at, promise }
const byKey = new Map(); // KEY -> { at, promise }

/** The projects the person can see (not archived), as GET /api/projects returns them. */
export function projectList(refresh = false) {
  if (refresh || !fresh(list)) {
    const entry = { at: Date.now(), promise: get('/api/projects').then((r) => r.projects) };
    entry.promise.catch(() => {
      if (list === entry) list = null;
    });
    list = entry;
  }
  return list.promise;
}

/** One project's payload (statuses, sprints, members, fields, components, releases, workflow, the person's rights). */
export function project(key, refresh = false) {
  const id = String(key).toUpperCase();
  if (refresh || !fresh(byKey.get(id))) {
    const entry = { at: Date.now(), promise: get(`/api/projects/${key}`).then((r) => r.project) };
    entry.promise.catch(() => {
      if (byKey.get(id) === entry) byKey.delete(id);
    });
    byKey.set(id, entry);
  }
  return byKey.get(id).promise;
}

/** Drop what is cached: everything, or the list and one project. */
export function forgetProjects(key) {
  list = null;
  if (key) byKey.delete(String(key).toUpperCase());
  else byKey.clear();
}
