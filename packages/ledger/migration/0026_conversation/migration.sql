CREATE TABLE IF NOT EXISTS conversation (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  data TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversation_endpoint_status
  ON conversation(endpoint_id, status);
CREATE INDEX IF NOT EXISTS idx_conversation_owner
  ON conversation(owner_kind, owner_id, time_created);
