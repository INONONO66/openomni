-- Rebuild communication state tables with FK constraints for databases that
-- already applied the original 0002 migration before the constraints existed.
-- Orphan rows are intentionally dropped: PendingAsk and WorkerGrant are durable
-- authority state and must not outlive their owning session/run.

CREATE TABLE pending_ask_new (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  status TEXT NOT NULL,
  origin_session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
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

INSERT INTO pending_ask_new (
  id, data, status, origin_session_id, endpoint_id, channel_id,
  external_message_id, reply_to_message_id, thread_id, token_hash,
  external_conversation_id, time_created, time_updated
)
SELECT
  p.id, p.data, p.status, p.origin_session_id, p.endpoint_id, p.channel_id,
  p.external_message_id, p.reply_to_message_id, p.thread_id, p.token_hash,
  p.external_conversation_id, p.time_created, p.time_updated
FROM pending_ask p
JOIN session s ON s.id = p.origin_session_id;

DROP TABLE pending_ask;
ALTER TABLE pending_ask_new RENAME TO pending_ask;

CREATE INDEX idx_pending_ask_status ON pending_ask(status);
CREATE INDEX idx_pending_ask_origin ON pending_ask(origin_session_id, time_created);
CREATE INDEX idx_pending_ask_correlation
  ON pending_ask(endpoint_id, channel_id, external_message_id, reply_to_message_id, thread_id);
CREATE INDEX idx_pending_ask_token_hash ON pending_ask(token_hash);
CREATE INDEX idx_pending_ask_external_conversation
  ON pending_ask(external_conversation_id);

CREATE TABLE worker_grant_new (
  id TEXT PRIMARY KEY,
  worker_run_id TEXT NOT NULL REFERENCES worker_run_state(run_id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  expires_at INTEGER
);

INSERT INTO worker_grant_new (
  id, worker_run_id, data, status, version, time_created, time_updated, expires_at
)
SELECT
  g.id, g.worker_run_id, g.data, g.status, g.version, g.time_created, g.time_updated, g.expires_at
FROM worker_grant g
JOIN worker_run_state r ON r.run_id = g.worker_run_id;

DROP TABLE worker_grant;
ALTER TABLE worker_grant_new RENAME TO worker_grant;

CREATE INDEX idx_worker_grant_worker ON worker_grant(worker_run_id);
CREATE INDEX idx_worker_grant_status ON worker_grant(status);
