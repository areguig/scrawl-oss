CREATE TABLE lint_stats (
  day TEXT NOT NULL,
  code TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (day, code)
);
