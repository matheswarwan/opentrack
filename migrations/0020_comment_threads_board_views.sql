-- Comment reactions, threaded replies and saved board views.
-- comments.parent_id: the top comment of a thread (one level of nesting; a reply to a reply attaches to the top
-- comment). No foreign key, so a backup can be restored in any row order; the app keeps it consistent.
-- comments.deleted_at: set when a comment with replies is deleted. The row stays (body emptied) so its replies keep
-- their place, and the UI shows "Comment deleted". Comments without replies are removed as before.
ALTER TABLE comments ADD COLUMN parent_id TEXT;
ALTER TABLE comments ADD COLUMN deleted_at TEXT;
CREATE INDEX idx_comments_parent ON comments(parent_id);

-- One row per person, comment and reaction (a short id such as 'thumbsup'; the UI draws the emoji).
CREATE TABLE comment_reactions (
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (comment_id, user_id, reaction)
);
CREATE INDEX idx_comment_reactions_user ON comment_reactions(user_id);

-- Saved board filters. shared = 1: everyone in the project sees it (guests never do); 0: only the owner.
-- filters: JSON text { scope, text, mine, assignees, type, label, subtasks, lanes, oldDone }.
CREATE TABLE board_views (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  shared INTEGER NOT NULL DEFAULT 0,
  filters TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_board_views_project ON board_views(project_id, owner_id);

-- Each person's default board view per project.
CREATE TABLE board_view_defaults (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  view_id TEXT NOT NULL REFERENCES board_views(id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, project_id)
);
