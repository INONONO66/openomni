ALTER TABLE session ADD COLUMN tools_generation INTEGER NOT NULL DEFAULT 0 CHECK (tools_generation >= 0);
ALTER TABLE session ADD COLUMN system_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE session ADD COLUMN policy_generation INTEGER NOT NULL DEFAULT 0 CHECK (policy_generation >= 0);

CREATE TABLE inbox_next (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('prompt', 'interrupt', 'resume')),
  content TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (json_valid(origin)),
  encoding_version INTEGER NOT NULL CHECK (encoding_version = 1),
  status TEXT NOT NULL CHECK (status IN ('pending', 'consumed')),
  consumed_by TEXT,
  consumed_at INTEGER CHECK (consumed_at IS NULL OR consumed_at >= 0),
  time_created INTEGER NOT NULL CHECK (time_created >= 0),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  CHECK ((status = 'pending' AND consumed_by IS NULL AND consumed_at IS NULL)
      OR (status = 'consumed' AND consumed_by IS NOT NULL AND consumed_at IS NOT NULL)),
  UNIQUE (session_id, ordinal)
);
INSERT INTO inbox_next (
  id, session_id, kind, content, origin, encoding_version, status,
  consumed_by, consumed_at, time_created, ordinal
)
SELECT
  id, session_id, kind, content, origin, encoding_version,
  CASE status WHEN 'claimed' THEN 'consumed' ELSE status END,
  claimed_by, claimed_at, time_created, ordinal
FROM inbox;
DROP TABLE inbox;
ALTER TABLE inbox_next RENAME TO inbox;
CREATE INDEX idx_inbox_pending ON inbox(session_id, status, ordinal);
