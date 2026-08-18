CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  role TEXT,
  time_created INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed'
);

CREATE INDEX IF NOT EXISTS idx_message_session_time ON message(session_id, time_created, id);
CREATE INDEX IF NOT EXISTS idx_message_status ON message(session_id, status);

CREATE TABLE IF NOT EXISTS part (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  type TEXT,
  time_start INTEGER
);

CREATE INDEX IF NOT EXISTS idx_part_message ON part(message_id);
CREATE INDEX IF NOT EXISTS idx_part_message_id ON part(message_id, id);

CREATE TABLE IF NOT EXISTS surface_key (
  key TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  time_created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_surface_key_session ON surface_key(session_id);

CREATE TABLE IF NOT EXISTS artifact (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  meta TEXT NOT NULL,
  content TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artifact_session ON artifact(session_id);

CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  data TEXT NOT NULL,
  time_created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_log_session_id ON event_log(session_id, id);

CREATE TABLE IF NOT EXISTS background_task (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  parent_session_id TEXT NOT NULL,
  data TEXT NOT NULL,
  output TEXT,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bg_task_status ON background_task(status);
CREATE INDEX IF NOT EXISTS idx_bg_task_parent ON background_task(parent_session_id);

CREATE TABLE IF NOT EXISTS task (
  id TEXT PRIMARY KEY,
  owner_type TEXT,
  owner_id TEXT,
  status TEXT NOT NULL,
  data TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_status ON task(status, time_created);

CREATE TABLE IF NOT EXISTS task_run (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  trigger_data TEXT,
  data TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_run_task ON task_run(task_id);
CREATE INDEX IF NOT EXISTS idx_task_run_status ON task_run(status, time_created);

CREATE TABLE IF NOT EXISTS task_idempotency (
  key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES task_run(id) ON DELETE CASCADE,
  time_created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_idempotency_run ON task_idempotency(run_id);

CREATE TABLE IF NOT EXISTS plan (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS todo (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  priority TEXT NOT NULL DEFAULT 'medium',
  position INTEGER NOT NULL DEFAULT 0,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_todo_session ON todo(session_id, position);

CREATE TABLE IF NOT EXISTS bus_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES session(id) ON DELETE CASCADE,
  run_id TEXT,
  event_type TEXT NOT NULL,
  category TEXT NOT NULL,
  data TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  duration_ms INTEGER,
  time_created INTEGER NOT NULL,
  prev_hash TEXT,
  event_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_bus_event_session_time ON bus_event(session_id, time_created);
CREATE INDEX IF NOT EXISTS idx_bus_event_run_time ON bus_event(run_id, time_created);
CREATE INDEX IF NOT EXISTS idx_bus_event_type_session ON bus_event(event_type, session_id);
CREATE INDEX IF NOT EXISTS idx_bus_event_category_session ON bus_event(category, session_id);
CREATE INDEX IF NOT EXISTS idx_bus_event_trace ON bus_event(trace_id);
CREATE INDEX IF NOT EXISTS idx_bus_event_hash ON bus_event(event_hash);

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

CREATE TABLE IF NOT EXISTS work_item (
  hash TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  status TEXT NOT NULL,
  assignee_id TEXT,
  session_id TEXT,
  parent_hash TEXT,
  source_channel TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_work_item_status ON work_item(status);
CREATE INDEX IF NOT EXISTS idx_work_item_assignee ON work_item(assignee_id);
CREATE INDEX IF NOT EXISTS idx_work_item_session ON work_item(session_id);
CREATE INDEX IF NOT EXISTS idx_work_item_parent ON work_item(parent_hash);
