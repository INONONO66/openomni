CREATE TABLE IF NOT EXISTS pending_ask (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  status TEXT NOT NULL,
  origin_session_id TEXT NOT NULL,
  endpoint_id TEXT,
  channel_id TEXT,
  external_message_id TEXT,
  reply_to_message_id TEXT,
  thread_id TEXT,
  token_hash TEXT,
  external_conversation_id TEXT,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_ask_status ON pending_ask(status);
CREATE INDEX IF NOT EXISTS idx_pending_ask_origin ON pending_ask(origin_session_id, time_created);
CREATE INDEX IF NOT EXISTS idx_pending_ask_correlation
  ON pending_ask(endpoint_id, channel_id, external_message_id, reply_to_message_id, thread_id);
CREATE INDEX IF NOT EXISTS idx_pending_ask_token_hash ON pending_ask(token_hash);
CREATE INDEX IF NOT EXISTS idx_pending_ask_external_conversation
  ON pending_ask(external_conversation_id);

CREATE TABLE IF NOT EXISTS worker_grant (
  id TEXT PRIMARY KEY,
  worker_run_id TEXT NOT NULL,
  data TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  expires_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_worker_grant_worker ON worker_grant(worker_run_id);
CREATE INDEX IF NOT EXISTS idx_worker_grant_status ON worker_grant(status);
