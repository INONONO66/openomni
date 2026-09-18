CREATE TABLE decision_fact (
  key TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  row_hash TEXT NOT NULL,
  time_created INTEGER NOT NULL
);
