CREATE TABLE IF NOT EXISTS channel_grant (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  surface TEXT NOT NULL,
  workspace TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_channel_grant_lookup
  ON channel_grant(surface, workspace, channel);

CREATE INDEX IF NOT EXISTS idx_channel_grant_kind
  ON channel_grant(kind);
