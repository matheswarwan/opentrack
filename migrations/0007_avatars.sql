-- Profile photos. The image is a data URL (PNG, JPEG or WebP, at most about 200 KB),
-- kept out of the users table so user queries stay small.
-- users.avatar_version changes on every upload and is NULL when there is no photo;
-- it goes into the photo URL so browsers can cache it.
CREATE TABLE user_avatars (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  image TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE users ADD COLUMN avatar_version TEXT;
