CREATE TABLE IF NOT EXISTS blacklist (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_blacklist_kind_value ON blacklist(kind, value);
CREATE INDEX IF NOT EXISTS idx_blacklist_expires ON blacklist(expires_at);
