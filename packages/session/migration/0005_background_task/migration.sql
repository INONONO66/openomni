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
