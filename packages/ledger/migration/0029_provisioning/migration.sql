CREATE TABLE IF NOT EXISTS person (
  id TEXT PRIMARY KEY,
  trust_tier TEXT NOT NULL,
  data TEXT NOT NULL,
  revision INTEGER NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_instance (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  data TEXT NOT NULL,
  revision INTEGER NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS secret (
  id TEXT PRIMARY KEY,
  ciphertext BLOB NOT NULL,
  wrapped_dek BLOB NOT NULL,
  kek_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  rotated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_person_trust_tier ON person(trust_tier);
CREATE INDEX IF NOT EXISTS idx_channel_instance_provider ON channel_instance(provider);
