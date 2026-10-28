-- A JSON document the page reads inline, and whether each update keeps the page it replaces as an edition.
ALTER TABLE pads ADD COLUMN data TEXT;
ALTER TABLE pads ADD COLUMN series INTEGER NOT NULL DEFAULT 0;
CREATE TABLE editions (
  pad_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  title TEXT NOT NULL,
  html TEXT NOT NULL,
  data TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (pad_id, n)
);
