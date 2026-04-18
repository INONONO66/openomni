CREATE TABLE IF NOT EXISTS todo_new (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', priority TEXT NOT NULL DEFAULT 'medium', position INTEGER NOT NULL DEFAULT 0, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
INSERT OR IGNORE INTO todo_new SELECT * FROM todo;
DROP TABLE IF EXISTS todo;
ALTER TABLE todo_new RENAME TO todo;
CREATE INDEX IF NOT EXISTS idx_todo_session ON todo(session_id, position);
CREATE INDEX IF NOT EXISTS idx_task_idempotency_run ON task_idempotency(run_id);
