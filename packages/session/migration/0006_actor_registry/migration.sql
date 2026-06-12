CREATE TABLE IF NOT EXISTS actor_identity (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  kind TEXT NOT NULL,
  trust_tier TEXT NOT NULL,
  relationship TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_actor_identity_trust_tier ON actor_identity(trust_tier);

CREATE TABLE IF NOT EXISTS actor_endpoint (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES actor_identity(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  channel TEXT NOT NULL,
  workspace TEXT NOT NULL,
  external_id TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_actor_endpoint_actor ON actor_endpoint(actor_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_actor_endpoint_lookup ON actor_endpoint(channel, workspace, external_id);
