CREATE TABLE IF NOT EXISTS pending_interaction (
  id TEXT PRIMARY KEY,
  worker_run_id TEXT NOT NULL REFERENCES worker_run_state(run_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  status TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  reply_to_message_id TEXT,
  thread_id TEXT,
  token_hash TEXT,
  external_conversation_id TEXT,
  expires_at INTEGER NOT NULL,
  follow_up_until INTEGER,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_interaction_status
  ON pending_interaction(status);
CREATE INDEX IF NOT EXISTS idx_pending_interaction_worker
  ON pending_interaction(worker_run_id, time_created);
CREATE INDEX IF NOT EXISTS idx_pending_interaction_session
  ON pending_interaction(session_id, time_created);
CREATE INDEX IF NOT EXISTS idx_pending_interaction_correlation
  ON pending_interaction(endpoint_id, channel_id, reply_to_message_id, thread_id);
CREATE INDEX IF NOT EXISTS idx_pending_interaction_token_hash
  ON pending_interaction(token_hash);
CREATE INDEX IF NOT EXISTS idx_pending_interaction_external_conversation
  ON pending_interaction(external_conversation_id);
