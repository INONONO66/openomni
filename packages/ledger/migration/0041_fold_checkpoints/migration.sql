-- Rebuild only the kind constraint; copy historical JSON and chain bytes verbatim.
CREATE TABLE action_next (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES action(id),
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'prompt', 'turn', 'llm', 'attempt', 'tool', 'message', 'inbox.deliver',
    'compaction', 'fold.checkpoint', 'alarm.arm', 'alarm.fired', 'alarm.paused',
    'session.configure', 'policy.decision', 'request', 'reply', 'outbound'
  )),
  intent TEXT NOT NULL CHECK (json_valid(intent)),
  effect TEXT NOT NULL CHECK (json_valid(effect)),
  revert TEXT CHECK (revert IS NULL OR json_valid(revert)),
  irreversible INTEGER NOT NULL CHECK (irreversible IN (0, 1)),
  encoding_version INTEGER NOT NULL CHECK (encoding_version = 1),
  ts INTEGER NOT NULL CHECK (ts >= 0),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  prev_hash TEXT,
  action_hash TEXT,
  CHECK ((revert IS NOT NULL) <> (irreversible = 1)),
  UNIQUE (session_id, ordinal)
);
INSERT INTO action_next (rowid, id, parent_id, session_id, kind, intent, effect, revert, irreversible, encoding_version, ts, ordinal, prev_hash, action_hash)
SELECT rowid, id, parent_id, session_id, kind, intent, effect, revert, irreversible, encoding_version, ts, ordinal, prev_hash, action_hash FROM action;
DROP TABLE action;
ALTER TABLE action_next RENAME TO action;
CREATE INDEX idx_action_parent ON action(session_id, parent_id, ordinal);
CREATE UNIQUE INDEX action_hash_unique ON action(action_hash);
CREATE INDEX idx_action_kind_revision ON action(session_id, kind, ordinal DESC);
CREATE INDEX idx_action_generation ON action(session_id, json_extract(effect, '$.snapshot.generation'), ordinal DESC) WHERE kind = 'session.configure' AND json_valid(effect);
CREATE INDEX idx_action_turn_terminal ON action(session_id, json_extract(effect, '$.turnId'), ordinal DESC) WHERE kind = 'turn' AND json_extract(effect, '$.phase') = 'terminal';
CREATE INDEX idx_action_turn_intent ON action(session_id, json_extract(intent, '$.phase'), ordinal DESC) WHERE kind = 'turn';
CREATE INDEX idx_action_turn_resume ON action(session_id, json_extract(intent, '$.turnId'), ordinal DESC) WHERE kind = 'turn';
CREATE INDEX idx_action_turn_effect ON action(session_id, json_extract(effect, '$.turnId'), ordinal DESC) WHERE kind IN ('turn', 'inbox.deliver');
CREATE INDEX idx_action_input ON action(session_id, json_extract(intent, '$.inputId'), ordinal DESC) WHERE kind IN ('request', 'reply');
CREATE INDEX idx_action_request_state ON action(json_extract(effect, '$.request.requestId')) WHERE kind IN ('request', 'reply') AND json_extract(effect, '$.phase') = 'state';
CREATE INDEX idx_action_outbound_state ON action(session_id, json_extract(effect, '$.outbound.message.messageId'), ordinal DESC) WHERE kind = 'outbound';
CREATE INDEX idx_action_wave ON action(session_id, json_extract(intent, '$.waveId'), ordinal);

CREATE TABLE policy_next (
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'prompt', 'turn', 'llm', 'attempt', 'tool', 'message', 'inbox.deliver',
    'compaction', 'fold.checkpoint', 'alarm.arm', 'alarm.fired', 'alarm.paused',
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
