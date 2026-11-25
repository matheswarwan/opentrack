// Recently opened projects (per browser), for the sidebar.
const KEY = 'it_recent_projects';
export function recentProjectKeys() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]');
  } catch {
    return [];
  }
}
export function rememberProject(key) {
  try {
    const list = [key, ...recentProjectKeys().filter((k) => k !== key)].slice(0, 8);
    localStorage.setItem(KEY, JSON.stringify(list));
    window.dispatchEvent(new Event('it-recent'));
  } catch {
    /* storage blocked */
  }
}
