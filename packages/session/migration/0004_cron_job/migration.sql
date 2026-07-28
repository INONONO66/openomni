CREATE TABLE IF NOT EXISTS cron_job (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);
