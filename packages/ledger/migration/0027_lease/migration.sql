CREATE TABLE IF NOT EXISTS lease (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  holder_delegation_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  data TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lease_conversation_status
  ON lease(conversation_id, status);
CREATE INDEX IF NOT EXISTS idx_lease_holder_status
  ON lease(holder_delegation_id, status);
