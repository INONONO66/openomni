-- Original invocation history is preserved; unresolved legacy rows are refused by the runner.
-- Archived terminal rows are retained indefinitely with their native values and rowids.
CREATE TABLE archive_969_wait (
  id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  origin_message_id TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  partial INTEGER NOT NULL,
  endpoint_id TEXT,
  channel_id TEXT,
  reply_to_message_id TEXT,
  thread_id TEXT,
  token_hash TEXT,
  external_conversation_id TEXT,
  expires_at INTEGER NOT NULL,
  follow_up_until INTEGER,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

INSERT INTO archive_969_wait (rowid, id, owner_kind, owner_id, origin_message_id, data, revision, status, partial, endpoint_id, channel_id, reply_to_message_id, thread_id, token_hash, external_conversation_id, expires_at, follow_up_until, time_created, time_updated) SELECT rowid, * FROM wait;
DROP TABLE wait;
CREATE TRIGGER archive_969_wait_insert BEFORE INSERT ON archive_969_wait
BEGIN SELECT RAISE(ABORT, 'immutable_archive'); END;
CREATE TRIGGER archive_969_wait_update BEFORE UPDATE ON archive_969_wait
BEGIN SELECT RAISE(ABORT, 'immutable_archive'); END;
CREATE TRIGGER archive_969_wait_delete BEFORE DELETE ON archive_969_wait
BEGIN SELECT RAISE(ABORT, 'immutable_archive'); END;
CREATE TABLE archive_969_approval (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  deadline INTEGER NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

INSERT INTO archive_969_approval (rowid, id, data, revision, status, deadline, time_created, time_updated) SELECT rowid, * FROM approval;
DROP TABLE approval;
CREATE TRIGGER archive_969_approval_insert BEFORE INSERT ON archive_969_approval
BEGIN SELECT RAISE(ABORT, 'immutable_archive'); END;
CREATE TRIGGER archive_969_approval_update BEFORE UPDATE ON archive_969_approval
BEGIN SELECT RAISE(ABORT, 'immutable_archive'); END;
CREATE TRIGGER archive_969_approval_delete BEFORE DELETE ON archive_969_approval
BEGIN SELECT RAISE(ABORT, 'immutable_archive'); END;

CREATE TABLE action_next (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES action(id),
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'prompt', 'turn', 'llm', 'attempt', 'tool', 'message', 'inbox.deliver',
    'compaction', 'alarm.arm', 'alarm.fired', 'alarm.paused',
    'session.configure', 'policy.decision', 'request', 'reply', 'outbound'
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
INSERT INTO action_next (rowid, id, parent_id, session_id, kind, intent, effect, revert, irreversible, encoding_version, ts, ordinal)
SELECT rowid, id, parent_id, session_id, kind, intent, effect, revert, irreversible, encoding_version, ts, ordinal FROM action;
DROP TABLE action;
ALTER TABLE action_next RENAME TO action;
CREATE INDEX idx_action_parent ON action(session_id, parent_id, ordinal);

CREATE TABLE policy_next (
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'prompt', 'turn', 'llm', 'attempt', 'tool', 'message', 'inbox.deliver',
    'compaction', 'alarm.arm', 'alarm.fired', 'alarm.paused',
    'session.configure', 'policy.decision', 'request', 'reply', 'outbound'
  )),
  phase TEXT NOT NULL CHECK (phase IN ('pre', 'post')),
  match TEXT NOT NULL CHECK (json_valid(match)),
  verdict TEXT NOT NULL CHECK (json_valid(verdict)),
  encoding_version INTEGER NOT NULL CHECK (encoding_version = 1),
  priority INTEGER NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  PRIMARY KEY (generation, name, kind, phase)
);
INSERT INTO policy_next (rowid, name, kind, phase, match, verdict, encoding_version, priority, generation)
SELECT rowid, name, kind, phase, match, verdict, encoding_version, priority, generation FROM policy;
DROP TABLE policy;
ALTER TABLE policy_next RENAME TO policy;
CREATE INDEX idx_policy_read ON policy(generation, kind, phase, priority DESC, name);

