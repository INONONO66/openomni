CREATE TABLE IF NOT EXISTS bus_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES session(id) ON DELETE CASCADE,
  run_id TEXT,
  event_type TEXT NOT NULL,
  category TEXT NOT NULL,
  data TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  duration_ms INTEGER,
  time_created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bus_event_session_time ON bus_event(session_id, time_created);
CREATE INDEX IF NOT EXISTS idx_bus_event_run_time ON bus_event(run_id, time_created);
CREATE INDEX IF NOT EXISTS idx_bus_event_type_session ON bus_event(event_type, session_id);
CREATE INDEX IF NOT EXISTS idx_bus_event_category_session ON bus_event(category, session_id);
CREATE INDEX IF NOT EXISTS idx_bus_event_trace ON bus_event(trace_id);

CREATE TABLE IF NOT EXISTS worker_run_state (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  parent_session_id TEXT,
  agent_name TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  resume_count INTEGER NOT NULL DEFAULT 0,
  assigned_step_id TEXT,
  error TEXT,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_worker_run_state_session_time ON worker_run_state(session_id, time_created);
