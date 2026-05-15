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
