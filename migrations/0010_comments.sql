-- What readers ask the author to change; only the edit key holder reads them.
CREATE TABLE comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pad_id TEXT NOT NULL,
  text TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX comments_pad ON comments (pad_id, id);
CREATE INDEX comments_ip ON comments (ip_hash, created_at);
