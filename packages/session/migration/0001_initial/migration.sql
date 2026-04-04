CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  data TEXT NOT NULL,
  role TEXT,
  time_created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_message_session ON message(session_id);

CREATE TABLE IF NOT EXISTS part (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  data TEXT NOT NULL,
  type TEXT,
  time_start INTEGER
);

CREATE INDEX IF NOT EXISTS idx_part_message ON part(message_id);
