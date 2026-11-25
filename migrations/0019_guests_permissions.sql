-- Guests (external clients) and finer project permissions. Rules: server/lib/access.js.
-- users.role may now be 'guest'. A guest sees only projects they are a member of (never open projects), and their
-- project_members.role is one of 'guest-view' (read only), 'guest-comment' (read, comment, watch) or 'guest-edit'
-- (also create issues and edit the issues they reported). Only guests get these three roles.
-- comments.internal: 1 = an internal note, never shown to guests (nor notified to them).
ALTER TABLE comments ADD COLUMN internal INTEGER NOT NULL DEFAULT 0;
-- attachments.internal: 1 = added while writing an internal note; never listed or served to guests.
ALTER TABLE attachments ADD COLUMN internal INTEGER NOT NULL DEFAULT 0;
-- Project permissions, set by project admins:
-- perm_delete: 'reporter' (the reporter and project admins) or 'admins' (project admins only) can delete issues.
-- perm_sprints: 'members' (anyone who can edit issues) or 'admins' manage sprints and move issues between sprints.
-- perm_create: 'members' (anyone who can edit issues, and guest editors) or 'admins' create issues.
-- perm_comment: 'all' (everyone who can see the project and may comment) or 'members' (no guests) comment.
ALTER TABLE projects ADD COLUMN perm_delete TEXT NOT NULL DEFAULT 'reporter';
ALTER TABLE projects ADD COLUMN perm_sprints TEXT NOT NULL DEFAULT 'members';
ALTER TABLE projects ADD COLUMN perm_create TEXT NOT NULL DEFAULT 'members';
ALTER TABLE projects ADD COLUMN perm_comment TEXT NOT NULL DEFAULT 'all';
