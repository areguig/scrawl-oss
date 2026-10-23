CREATE TABLE images (
  pad_id TEXT NOT NULL,
  name TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (pad_id, name)
);
