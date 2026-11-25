-- Workspace fonts (server/routes/fonts.js): font files an admin uploads (the workspace must hold a licence for them),
-- served publicly at /api/auth/fonts/<id> and used through @font-face with the families in the settings
-- fontHeading and fontBody. data: the file, base64. One file per family + weight + style.
CREATE TABLE brand_fonts (
  id TEXT PRIMARY KEY,
  family TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 400,
  style TEXT NOT NULL DEFAULT 'normal',
  format TEXT NOT NULL,
  size INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE (family, weight, style)
);
