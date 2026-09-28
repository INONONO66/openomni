/**
 * Fresh catalog DDL (W5.2 #1197) — the only catalog schema owner. One small
 * catalog file per deployment holds the cross-session facts: the session
 * index (id/parent/role plus the runner-generation fence rotated by CAS at
 * entity activation, review F5) and the perimeter/identity/policy tables.
 * There is no migration plane and the legacy `catalog.db` is never read.
 * The five `cluster_*` tables live in the same file but are created and owned
 * by effect/cluster's SqlMessageStorage/SqlRunnerStorage, not by this DDL.
 */
export const CATALOG_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS session_index (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    role TEXT NOT NULL CHECK (role IN ('resident', 'worker')),
    fence INTEGER NOT NULL DEFAULT 0 CHECK (fence >= 0),
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS actor_identity (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    kind TEXT NOT NULL,
    trust_tier TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_actor_identity_trust_tier ON actor_identity(trust_tier)",
  `CREATE TABLE IF NOT EXISTS actor_endpoint (
    id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL REFERENCES actor_identity(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    channel TEXT NOT NULL,
    workspace TEXT NOT NULL,
    external_id TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_actor_endpoint_actor ON actor_endpoint(actor_id)",
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_actor_endpoint_lookup
     ON actor_endpoint(channel, workspace, external_id)`,
  `CREATE TABLE IF NOT EXISTS person (
    id TEXT PRIMARY KEY,
    trust_tier TEXT NOT NULL,
    data TEXT NOT NULL,
    revision INTEGER NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_person_trust_tier ON person(trust_tier)",
  `CREATE TABLE IF NOT EXISTS secret (
    id TEXT PRIMARY KEY,
    ciphertext BLOB NOT NULL,
    wrapped_dek BLOB NOT NULL,
    kek_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    rotated_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS channel_instance (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    data TEXT NOT NULL,
    revision INTEGER NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_channel_instance_provider ON channel_instance(provider)",
  `CREATE TABLE IF NOT EXISTS channel_grant (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    surface TEXT NOT NULL,
    workspace TEXT NOT NULL DEFAULT '',
    channel TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_channel_grant_kind ON channel_grant(kind)",
  `CREATE INDEX IF NOT EXISTS idx_channel_grant_lookup
     ON channel_grant(surface, workspace, channel)`,
  `CREATE TABLE IF NOT EXISTS reply_grant (
    id TEXT PRIMARY KEY NOT NULL,
    data TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    target_actor_id TEXT NOT NULL,
    surface_key TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    UNIQUE (rule_id, target_actor_id, surface_key)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_reply_grant_expiry ON reply_grant (expires_at)",
  "CREATE INDEX IF NOT EXISTS idx_reply_grant_rule_expiry ON reply_grant (rule_id, expires_at)",
  `CREATE TABLE IF NOT EXISTS egress_debit (
    id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL,
    target_actor_id TEXT NOT NULL,
    class TEXT NOT NULL,
    at INTEGER NOT NULL,
    time_created INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_egress_debit_pair_at
     ON egress_debit(sender_id, target_actor_id, at)`,
  `CREATE TABLE IF NOT EXISTS blacklist (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    kind TEXT NOT NULL,
    value TEXT NOT NULL,
    expires_at INTEGER,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_blacklist_expires ON blacklist(expires_at)",
  "CREATE INDEX IF NOT EXISTS idx_blacklist_kind_value ON blacklist(kind, value)",
  `CREATE TABLE IF NOT EXISTS surface_key (
    key TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_surface_key_session ON surface_key(session_id)",
  `CREATE TABLE IF NOT EXISTS policy (
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
  )`,
  "CREATE INDEX IF NOT EXISTS idx_policy_read ON policy(generation, kind, phase, priority DESC, name)",
];
