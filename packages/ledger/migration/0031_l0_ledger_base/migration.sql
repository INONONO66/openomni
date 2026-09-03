-- KERNEL L0 base. Existing session rows are lifted only when their persisted
-- JSON explicitly names a confirmed role; no inferred default is allowed.
CREATE TABLE _session_l0_guard (
  row_count INTEGER NOT NULL CHECK (row_count = 0)
);
INSERT INTO _session_l0_guard
SELECT COUNT(*)
FROM session
WHERE json_valid(data) = 0
   OR json_extract(data, '$.id') IS NOT id;
DROP TABLE _session_l0_guard;

ALTER TABLE session ADD COLUMN parent_id TEXT;
ALTER TABLE session ADD COLUMN role TEXT CHECK (role IN ('resident', 'worker'));
ALTER TABLE session ADD COLUMN lease_owner TEXT;
ALTER TABLE session ADD COLUMN lease_fence INTEGER NOT NULL DEFAULT 0 CHECK (lease_fence >= 0);
ALTER TABLE session ADD COLUMN lease_expires_at INTEGER;
ALTER TABLE session ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0);
ALTER TABLE session ADD COLUMN state TEXT NOT NULL DEFAULT 'idle'
  CHECK (state IN ('idle', 'running', 'interrupted'));
UPDATE session
SET parent_id = json_extract(data, '$.parentSessionId');
CREATE UNIQUE INDEX idx_session_role_not_null ON session(id) WHERE role IS NOT NULL;

CREATE TABLE action (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES action(id),
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'prompt', 'turn', 'llm', 'attempt', 'tool', 'message', 'inbox.deliver',
    'compaction', 'alarm.arm', 'alarm.fired', 'alarm.paused',
    'session.configure', 'policy.decision'
  )),
  intent TEXT NOT NULL CHECK (json_valid(intent)),
  effect TEXT NOT NULL CHECK (json_valid(effect)),
  revert TEXT CHECK (revert IS NULL OR json_valid(revert)),
  irreversible INTEGER NOT NULL CHECK (irreversible IN (0, 1)),
  encoding_version INTEGER NOT NULL CHECK (encoding_version = 1),
  ts INTEGER NOT NULL CHECK (ts >= 0),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  CHECK ((revert IS NOT NULL) <> (irreversible = 1)),
  UNIQUE (session_id, ordinal)
);
CREATE INDEX idx_action_parent ON action(session_id, parent_id, ordinal);

CREATE TABLE inbox (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('prompt', 'interrupt', 'resume')),
  content TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (json_valid(origin)),
  encoding_version INTEGER NOT NULL CHECK (encoding_version = 1),
  status TEXT NOT NULL CHECK (status IN ('pending', 'claimed')),
  claimed_by TEXT,
  claimed_at INTEGER CHECK (claimed_at IS NULL OR claimed_at >= 0),
  time_created INTEGER NOT NULL CHECK (time_created >= 0),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  CHECK ((status = 'pending' AND claimed_by IS NULL AND claimed_at IS NULL)
      OR (status = 'claimed' AND claimed_by IS NOT NULL AND claimed_at IS NOT NULL)),
  UNIQUE (session_id, ordinal)
);
CREATE INDEX idx_inbox_pending ON inbox(session_id, status, ordinal);

CREATE TABLE alarm (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('at', 'watch')),
  fire_at INTEGER NOT NULL CHECK (fire_at >= 0),
  spec TEXT CHECK (spec IS NULL OR json_valid(spec)),
  encoding_version INTEGER NOT NULL CHECK (encoding_version = 1),
  status TEXT NOT NULL CHECK (status IN ('armed', 'cancelled', 'fired', 'paused')),
  time_created INTEGER NOT NULL CHECK (time_created >= 0),
  time_updated INTEGER NOT NULL CHECK (time_updated >= 0)
);
CREATE INDEX idx_alarm_due ON alarm(status, fire_at, id);
CREATE INDEX idx_alarm_session ON alarm(session_id, status);

CREATE TABLE policy (
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'prompt', 'turn', 'llm', 'attempt', 'tool', 'message', 'inbox.deliver',
    'compaction', 'alarm.arm', 'alarm.fired', 'alarm.paused',
    'session.configure', 'policy.decision'
  )),
  phase TEXT NOT NULL CHECK (phase IN ('pre', 'post')),
  match TEXT NOT NULL CHECK (json_valid(match)),
  verdict TEXT NOT NULL CHECK (json_valid(verdict)),
  encoding_version INTEGER NOT NULL CHECK (encoding_version = 1),
  priority INTEGER NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  PRIMARY KEY (generation, name, kind, phase)
);
CREATE INDEX idx_policy_read ON policy(generation, kind, phase, priority DESC, name);
