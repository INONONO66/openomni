import type { Database } from "bun:sqlite";
import type { ObservationSink, Storage as ProtocolStorage } from "@openomni/protocol";
import { z } from "zod";
import { SessionNotFound } from "./errors";
import { openStoreDatabase, SILENT_OBSERVATION_SINK, StoreHandle } from "./session-file/index.js";
import { createSqliteActorRegistryAdapter } from "./storage/sqlite-actor-registry-adapter";
import { createSqliteBlacklistAdapter } from "./storage/sqlite-blacklist-adapter";
import { createSqliteChannelGrantAdapter } from "./storage/sqlite-channel-grant-adapter";
import { createSqliteEgressBudgetAdapter } from "./storage/sqlite-egress-budget-adapter";
import { createPolicies } from "./storage/sqlite-l0-policies.js";
import { createSqliteProvisioningAdapter } from "./storage/sqlite-provisioning-adapter";
import { createSqliteReplyGrantAdapter } from "./storage/sqlite-reply-grant-adapter";
import { createSqliteSurfaceKeyAdapter } from "./storage/sqlite-surface-key-adapter";

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
  "CREATE INDEX IF NOT EXISTS idx_session_index_parent ON session_index(parent_id, id)",
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
    -- Policy-row vocabulary, not the journal kind set (#1252): historical
    -- generations keep their legacy kind tokens byte-for-byte (#1251 migration),
    -- so the retired journal kinds stay admissible here.
    kind TEXT NOT NULL CHECK (kind IN (
      'prompt', 'signal', 'turn', 'llm', 'message', 'request', 'alarm',
      'session.configure', 'policy.decision', 'tool', 'compaction', 'action',
      'fold.checkpoint', 'attempt', 'inbox.deliver', 'alarm.arm', 'alarm.fired',
      'alarm.paused', 'reply', 'outbound'
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


export interface SessionIndexRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly role: "resident" | "worker";
  readonly fence: number;
  readonly createdAt: number;
}

export type SessionIndexInsert = Omit<SessionIndexRow, "fence">;

const SessionIndexSqlRow = z
  .object({
    id: z.string(),
    parent_id: z.string().nullable(),
    role: z.enum(["resident", "worker"]),
    fence: z.number().int().nonnegative(),
    created_at: z.number(),
  })
  .transform(
    (row): SessionIndexRow => ({
      id: row.id,
      parentId: row.parent_id,
      role: row.role,
      fence: row.fence,
      createdAt: row.created_at,
    }),
  );

const RotatedFence = z.object({ fence: z.number().int().positive() });

/**
 * Handle-scoped catalog file (W5.2 review F1): cross-session facts only — the
 * session index with its runner-generation fence, perimeter identity/grant
 * tables and policy rows. Never authorizes a session-file write by itself;
 * `commitSession`'s owner+fence check in the session file stays the authority.
 */
export class CatalogStore extends StoreHandle {
  readonly surfaceKey: ProtocolStorage.SurfaceKeySubAdapter;
  readonly egressBudget: ProtocolStorage.EgressBudgetSubAdapter;
  readonly actorRegistry: ProtocolStorage.ActorRegistrySubAdapter;
  readonly blacklist: ProtocolStorage.BlacklistSubAdapter;
  readonly channelGrant: ProtocolStorage.ChannelGrantSubAdapter;
  readonly replyGrant: ProtocolStorage.ReplyGrantSubAdapter;
  readonly provisioning: ProtocolStorage.ProvisioningSubAdapter;
  readonly policies: ProtocolStorage.PolicyRowSubAdapter;
  constructor(db: Database, observationSink: ObservationSink, now: () => number) {
    super(db, observationSink, now);
    this.surfaceKey = createSqliteSurfaceKeyAdapter(db, now);
    this.egressBudget = createSqliteEgressBudgetAdapter(db, now);
    this.actorRegistry = createSqliteActorRegistryAdapter(db, now);
    this.blacklist = createSqliteBlacklistAdapter(db, now);
    this.channelGrant = createSqliteChannelGrantAdapter(db, now);
    this.replyGrant = createSqliteReplyGrantAdapter(db);
    this.provisioning = createSqliteProvisioningAdapter(db, now);
    this.policies = createPolicies(db, this.transaction);
  }

  /** Registers a session in the index at fence 0; a lost race is not an error. */
  indexSession(input: SessionIndexInsert): boolean {
    const inserted = this.db
      .query(
        `INSERT INTO session_index (id, parent_id, role, fence, created_at)
         VALUES (?, ?, ?, 0, ?) ON CONFLICT(id) DO NOTHING`,
      )
      .run(input.id, input.parentId, input.role, input.createdAt);
    return inserted.changes === 1;
  }

  sessionIndex(id: string): SessionIndexRow | undefined {
    const row = SessionIndexSqlRow.nullable().parse(
      this.db.query("SELECT * FROM session_index WHERE id = ?").get(id),
    );
    return row === null ? undefined : row;
  }

  childSessionsPage(parentId: string, afterId: string, limit: number): SessionIndexRow[] {
    const size = z.number().int().positive().max(256).parse(limit);
    return z.array(SessionIndexSqlRow).parse(this.db.query(
      "SELECT * FROM session_index WHERE parent_id = ? AND id > ? ORDER BY id LIMIT ?",
    ).all(parentId, afterId, size));
  }

  /**
   * Runner-generation fence CAS (W5.2 review F5): one atomic increment under
   * BEGIN IMMEDIATE per entity activation. The winner writes the returned
   * fence into the session file; any writer still on an older fence is
   * refused "stale" by `commitSession`.
   */
  rotateFence(sessionId: string): number {
    return this.transaction(() => {
      const rotated = RotatedFence.nullable().parse(
        this.db
          .query("UPDATE session_index SET fence = fence + 1 WHERE id = ? RETURNING fence")
          .get(sessionId),
      );
      if (rotated === null) throw new SessionNotFound({ sessionId });
      return rotated.fence;
    });
  }
}

export interface OpenCatalogStoreOptions {
  /** Injected wall clock (#1245): catalog adapters never read ambient time. */
  readonly now: () => number;
  readonly observationSink?: ObservationSink;
}

export function openCatalogStore(path: string, options: OpenCatalogStoreOptions): CatalogStore {
  return new CatalogStore(
    openStoreDatabase(path, CATALOG_SCHEMA),
    options.observationSink ?? SILENT_OBSERVATION_SINK,
    options.now,
  );
}
