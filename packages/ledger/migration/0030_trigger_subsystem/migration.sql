CREATE TABLE IF NOT EXISTS trigger_record (
  id TEXT PRIMARY KEY,
  owner_session_id TEXT NOT NULL,
  state TEXT NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  revision INTEGER NOT NULL,
  expires_at INTEGER,
  next_fire_at INTEGER,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trigger_record_owner_state
  ON trigger_record(owner_session_id, state, time_created, id);

CREATE INDEX IF NOT EXISTS idx_trigger_record_due
  ON trigger_record(state, next_fire_at);

CREATE TABLE IF NOT EXISTS trigger_fire (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL REFERENCES trigger_record(id) ON DELETE CASCADE,
  owner_session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL,
  revision INTEGER NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trigger_fire_trigger_time
  ON trigger_fire(trigger_id, time_created, id);

CREATE INDEX IF NOT EXISTS idx_trigger_fire_status_time
  ON trigger_fire(status, time_created, id);

CREATE INDEX IF NOT EXISTS idx_trigger_fire_owner_status
  ON trigger_fire(owner_session_id, status, time_created, id);
