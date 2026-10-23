CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pad_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  details TEXT,
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (pad_id, ip_hash)
);

ALTER TABLE pads ADD COLUMN hidden_at INTEGER;
