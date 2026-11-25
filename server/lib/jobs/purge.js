// The trash_purge job: issues and projects that sat in the Trash longer than the trashDays setting are removed for good.
import { getSettings } from '../settings.js';
import { expiredItems, hardDeleteIssue } from '../trash.js';
import { expiredProjects, purgeProject } from '../projectTrash.js';

/** Remove Trash items older than the trashDays setting for good, a few at a time (oldest first). */
export async function purgeTrash(ctx, counts, room) {
  const settings = await getSettings(ctx.db);
  const days = Number(settings.trashDays) >= 1 ? Number(settings.trashDays) : 30;
  const cutoff = new Date(ctx.nowMs - days * 864e5).toISOString();
  const t = new Date(ctx.nowMs).toISOString();
  counts.purged = counts.purged || 0;
  counts.files = counts.files || 0;
  for (;;) {
    if (!room()) return { status: 'partial' };
    const items = await expiredItems(ctx.db, cutoff, Math.min(ctx.lim.batch, 10));
    if (!items.length) break;
    for (const it of items) {
      if (!room()) return { status: 'partial' };
      const r = await hardDeleteIssue(ctx.env, it, null, t, `in the Trash for more than ${days} days`);
      counts.purged += 1;
      counts.files += r.files;
    }
  }
  // deleted projects past the same period (one at a time: each removes a whole project)
  counts.projects = counts.projects || 0;
  for (;;) {
    if (!room()) return { status: 'partial' };
    const [p] = await expiredProjects(ctx.db, cutoff, 1);
    if (!p) break;
    const r = await purgeProject(ctx.env, p, null, t, `in the Trash for more than ${days} days`);
    counts.projects += 1;
    counts.files += r.external;
  }
  counts.summary = `${counts.purged} issue${counts.purged === 1 ? '' : 's'}${counts.projects ? ` and ${counts.projects} project${counts.projects === 1 ? '' : 's'}` : ''} removed for good (in the Trash for more than ${days} days)`;
  return { status: 'done' };
}
