CREATE TABLE IF NOT EXISTS approval (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  deadline INTEGER NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_approval_status_created
  ON approval(status, time_created);
