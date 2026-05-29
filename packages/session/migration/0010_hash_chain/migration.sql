-- Hash chain columns on bus_event for inline tamper detection
ALTER TABLE bus_event ADD COLUMN prev_hash TEXT;
ALTER TABLE bus_event ADD COLUMN event_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_bus_event_hash ON bus_event(event_hash);

-- Append-only audit table that survives CASCADE deletes on bus_event.
-- Stores hash + metadata only (no payload) so session deletion preserves
-- the integrity proof while removing sensitive data.
CREATE TABLE IF NOT EXISTS event_chain (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  event_type TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  time_created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_chain_session ON event_chain(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_event_chain_hash ON event_chain(event_hash);
