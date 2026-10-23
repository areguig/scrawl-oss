CREATE TABLE pads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  html TEXT NOT NULL,
  edit_key_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
