-- Current reply authority derived from committed admissions; immutable history is untouched.
CREATE TABLE reply_grant (
  id TEXT PRIMARY KEY NOT NULL,
  data TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  target_actor_id TEXT NOT NULL,
  surface_key TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE (rule_id, target_actor_id, surface_key)
);
CREATE INDEX idx_reply_grant_expiry ON reply_grant (expires_at);
CREATE INDEX idx_reply_grant_rule_expiry ON reply_grant (rule_id, expires_at);
