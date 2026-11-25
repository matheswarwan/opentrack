// Components and releases (fix versions) in the web app. The project payload (GET /api/projects/:key) has
// components: [{ id, name, defaultAssigneeId }] and releases: [{ id, name, status, releaseDate }].

export const RELEASE_STATUS = {
  unreleased: { label: 'Unreleased', cls: 'bg-slate-100 text-slate-700' },
  released: { label: 'Released', cls: 'bg-link text-white' },
  archived: { label: 'Archived', cls: 'bg-slate-200 text-slate-500' },
};

/** Fix versions that can be picked: unreleased and released ones (archived ones only show when already set). */
export const versionOptions = (project) =>
  (project?.releases || [])
    .filter((r) => r.status !== 'archived')
    .map((r) => ({ id: r.id, name: r.name, note: r.status === 'released' ? 'released' : '' }));
export const componentOptions = (project) => (project?.components || []).map((c) => ({ id: c.id, name: c.name }));

/** Percent done (0 to 100) of a release's progress by issues or points. */
export function percent(progress, by = 'issues') {
  const total = by === 'points' ? progress.points : progress.total;
  const done = by === 'points' ? progress.pointsDone : progress.done;
  return total ? Math.round((done / total) * 100) : 0;
}
