// Project switcher helpers: which project the Board link opens,
// the order projects are listed in, and where switching takes you.

// Recently opened first, then the rest by name.
export function orderProjects(projects, recent) {
  const byKey = new Map(projects.map((p) => [p.key, p]));
  const first = recent.map((k) => byKey.get(k)).filter(Boolean);
  const rest = projects.filter((p) => !recent.includes(p.key)).sort((a, b) => a.name.localeCompare(b.name));
  return [...first, ...rest];
}

// The project the Board link opens: the one you are in, else the last opened, else the first.
export function boardProjectKey(current, projects, recent) {
  const keys = new Set(projects.map((p) => p.key));
  if (current && keys.has(current)) return current;
  const last = recent.find((k) => keys.has(k));
  if (last) return last;
  return orderProjects(projects, recent)[0]?.key || null;
}

// Switching keeps you on the same project page (board, backlog, RAID...), like a
// business unit switcher; an issue or report page inside a project falls back to the board.
const KEEP = [
  'board',
  'backlog',
  'issues',
  'activity',
  'roadmap',
  'calendar',
  'releases',
  'status',
  'raid',
  'reports',
  'recurring',
  'settings',
];
export function switchPath(path, key) {
  const m = /^\/projects\/[^/]+\/([^/?#]+)\/?$/.exec(path || '');
  const page = m && KEEP.includes(m[1]) ? m[1] : 'board';
  return `/projects/${key}/${page}`;
}

export function filterProjects(list, text) {
  const t = text.trim().toLowerCase();
  if (!t) return list;
  return list.filter((p) => p.key.toLowerCase().includes(t) || p.name.toLowerCase().includes(t));
}

// Issues page: opened bare from the sidebar it shows the selected
// project (the switcher's, i.e. the last opened). Picking All projects is remembered.
const SCOPE_KEY = 'it_issues_scope';
export function issuesScope() {
  try {
    return localStorage.getItem(SCOPE_KEY) === 'all' ? 'all' : 'project';
  } catch {
    return 'project';
  }
}
export function rememberIssuesScope(project) {
  try {
    localStorage.setItem(SCOPE_KEY, project === 'all' ? 'all' : 'project');
  } catch {
    /* storage blocked */
  }
}
/** The project a bare /issues should open on, or null to show all projects. */
export function issuesDefaultProject(query, recent, scope) {
  if (Object.keys(query || {}).length) return null; // a link or filter chose already
  if (scope === 'all') return null;
  return recent[0] || null;
}
