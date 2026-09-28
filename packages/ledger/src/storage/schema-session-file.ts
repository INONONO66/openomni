/**
 * Fresh per-session ledger file DDL (W5.2 #1197) — the only session-file
 * schema owner. One file per session holds exactly three tables: the single
 * session row, the append-only action hash chain (0041 shape), and
 * first-writer-wins decision facts (0040 shape). There is no migration plane:
 * a session file is either fresh or already on this schema.
 *
 * The `data`/`time_created`/`time_updated` and `lease_expires_at` columns are
 * kept because the current write plane (`sqlite-l0-write.ts` insertSession /
 * commitSession) still reads and writes them; the lease-expiry predicate and
 * these legacy columns leave together with that write-plane rework (wave 3).
 */
export const SESSION_FILE_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    parent_id TEXT,
    role TEXT CHECK (role IN ('resident', 'worker')),
    lease_owner TEXT,
    lease_fence INTEGER NOT NULL DEFAULT 0 CHECK (lease_fence >= 0),
    lease_expires_at INTEGER,
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    state TEXT NOT NULL DEFAULT 'idle' CHECK (state IN ('idle', 'running', 'interrupted')),
    tools_generation INTEGER NOT NULL DEFAULT 0 CHECK (tools_generation >= 0),
    system_hash TEXT NOT NULL DEFAULT '',
    policy_generation INTEGER NOT NULL DEFAULT 0 CHECK (policy_generation >= 0)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_session_role_not_null
     ON session(id) WHERE role IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS action (
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
    prev_hash TEXT NOT NULL,
    action_hash TEXT NOT NULL,
    CHECK ((revert IS NOT NULL) <> (irreversible = 1)),
    UNIQUE (session_id, ordinal)
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS action_hash_unique ON action(action_hash)",
  `CREATE INDEX IF NOT EXISTS idx_action_generation
     ON action(session_id, json_extract(effect, '$.snapshot.generation'), ordinal DESC)
     WHERE kind = 'session.configure' AND json_valid(effect)`,
  `CREATE INDEX IF NOT EXISTS idx_action_input
     ON action(session_id, json_extract(intent, '$.inputId'), ordinal DESC)
     WHERE kind IN ('request', 'reply')`,
  "CREATE INDEX IF NOT EXISTS idx_action_kind_revision ON action(session_id, kind, ordinal DESC)",
  `CREATE INDEX IF NOT EXISTS idx_action_outbound_state
     ON action(session_id, json_extract(effect, '$.outbound.message.messageId'), ordinal DESC)
     WHERE kind = 'outbound'`,
  "CREATE INDEX IF NOT EXISTS idx_action_parent ON action(session_id, parent_id, ordinal)",
  `CREATE INDEX IF NOT EXISTS idx_action_request_state
     ON action(json_extract(effect, '$.request.requestId'))
     WHERE kind IN ('request', 'reply') AND json_extract(effect, '$.phase') = 'state'`,
  `CREATE INDEX IF NOT EXISTS idx_action_turn_effect
     ON action(session_id, json_extract(effect, '$.turnId'), ordinal DESC)
     WHERE kind IN ('turn', 'inbox.deliver')`,
  `CREATE INDEX IF NOT EXISTS idx_action_turn_intent
     ON action(session_id, json_extract(intent, '$.phase'), ordinal DESC)
     WHERE kind = 'turn'`,
  `CREATE INDEX IF NOT EXISTS idx_action_turn_resume
     ON action(session_id, json_extract(intent, '$.turnId'), ordinal DESC)
     WHERE kind = 'turn'`,
  `CREATE INDEX IF NOT EXISTS idx_action_turn_terminal
     ON action(session_id, json_extract(effect, '$.turnId'), ordinal DESC)
     WHERE kind = 'turn' AND json_extract(effect, '$.phase') = 'terminal'`,
  `CREATE INDEX IF NOT EXISTS idx_action_wave
     ON action(session_id, json_extract(intent, '$.waveId'), ordinal)`,
  `CREATE TABLE IF NOT EXISTS decision_fact (
    key TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    row_hash TEXT NOT NULL,
    time_created INTEGER NOT NULL
  )`,
];
