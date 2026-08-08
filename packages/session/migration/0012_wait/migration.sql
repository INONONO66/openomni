CREATE TABLE IF NOT EXISTS wait (
  id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  origin_message_id TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  partial INTEGER NOT NULL,
  endpoint_id TEXT,
  channel_id TEXT,
  reply_to_message_id TEXT,
  thread_id TEXT,
  token_hash TEXT,
  external_conversation_id TEXT,
  expires_at INTEGER NOT NULL,
  follow_up_until INTEGER,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wait_status_expires
  ON wait(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_wait_owner
  ON wait(owner_kind, owner_id, time_created);
CREATE INDEX IF NOT EXISTS idx_wait_correlation
  ON wait(endpoint_id, channel_id, reply_to_message_id, thread_id);
CREATE INDEX IF NOT EXISTS idx_wait_token_hash
  ON wait(token_hash);
CREATE INDEX IF NOT EXISTS idx_wait_external_conversation
  ON wait(external_conversation_id);
