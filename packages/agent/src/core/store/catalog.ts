import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ObservationSink, Storage as ProtocolStorage } from "@openomni/protocol";
import { z } from "zod";
import { CatalogVersionRefused, SessionNotFound } from "./errors";
import { bootstrapStoreDatabase, SILENT_OBSERVATION_SINK, StoreHandle } from "./session-file/index.js";
import { createPolicies } from "./storage/sqlite-l0-policies.js";

/**
 * Fresh catalog DDL (W5.2 #1197) — the only catalog schema owner. One small
 * catalog file per deployment holds the cross-session facts: the session
 * index (id/parent/role plus the runner-generation fence rotated by CAS at
 * entity activation, review F5) and the policy rows. The channel-facing
 * tables that shared this file are owned by `@openomni/channels` since #1317
 * (`packages/channels/src/store/sqlite/schema.ts`) and attach to the same
 * database handle. There is no migration plane and the legacy `catalog.db` is
 * never read.
 * The five `cluster_*` tables live in the same file but are created and owned
 * by effect/cluster's SqlMessageStorage/SqlRunnerStorage, not by this DDL.
 */
export const CATALOG_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS session_index (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    role TEXT NOT NULL CHECK (role IN ('resident', 'worker')),
    fence INTEGER NOT NULL DEFAULT 0 CHECK (fence >= 0),
    created_at INTEGER NOT NULL,
    has_armed INTEGER NOT NULL DEFAULT 0 CHECK (has_armed IN (0, 1))
  )`,
  "CREATE INDEX IF NOT EXISTS idx_session_index_parent ON session_index(parent_id, id)",
  `CREATE TABLE IF NOT EXISTS policy (
    name TEXT NOT NULL,
    -- Policy-row kinds are point kinds (#1251): the closed journal set plus
    -- the two historical tokens the legacy point mapping still converts
    -- (gate/migrate.ts). Old catalog files keep their original CREATE TABLE
    -- (IF NOT EXISTS), so historical rows stay byte-for-byte.
    kind TEXT NOT NULL CHECK (kind IN (
      'prompt', 'signal', 'turn', 'llm', 'message', 'request', 'alarm',
      'session.configure', 'policy.decision', 'tool', 'compaction', 'action',
      'fold.checkpoint', 'inbox.deliver', 'alarm.fired'
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

/**
 * Catalog schemaVersion (#1252): stamped into `PRAGMA user_version` when the
 * catalog is created or opened by code at least this new. A file whose marker
 * is greater than this constant was written by newer code and opens read-only.
 */
const CATALOG_SCHEMA_VERSION = 2;

const UserVersion = z.object({ user_version: z.number().int().nonnegative() });


export interface SessionIndexRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly role: "resident" | "worker";
  readonly fence: number;
  readonly createdAt: number;
  /** #1254 S3: the session MAY hold armed alarms; the boot sweep rescans it. */
  readonly hasArmed: boolean;
}

export type SessionIndexInsert = Omit<SessionIndexRow, "fence" | "hasArmed">;

const SessionIndexSqlRow = z
  .object({
    id: z.string(),
    parent_id: z.string().nullable(),
    role: z.enum(["resident", "worker"]),
    fence: z.number().int().nonnegative(),
    created_at: z.number(),
    // Optional: a newer-code file opened read-only may shape this differently.
    has_armed: z.number().int().optional(),
  })
  .transform(
    (row): SessionIndexRow => ({
      id: row.id,
      parentId: row.parent_id,
      role: row.role,
      fence: row.fence,
      createdAt: row.created_at,
      hasArmed: (row.has_armed ?? 0) === 1,
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
  readonly policies: ProtocolStorage.PolicyRowSubAdapter;
  /** Set only when the file's schemaVersion marker is newer than this build. */
  private readonly newerFileVersion: number | undefined;
  private readOnlyClosed = false;
  constructor(db: Database, observationSink: ObservationSink, now: () => number, newerFileVersion?: number) {
    super(db, observationSink, now);
    this.newerFileVersion = newerFileVersion;
    this.policies = createPolicies(db, this.transaction);
  }

  /**
   * The raw SQLite handle this catalog was opened on (#1317): the composition
   * root attaches the channels-owned store (`openChannelStore`) to the same
   * file. The catalog itself constructs nothing channel-facing.
   */
  get database(): Database {
    return this.db;
  }

  /** Refuses mutation on a catalog written by newer code (#1252): read-only. */
  private refuseNewerSchema(operation: "indexSession" | "rotateFence" | "markArmed"): void {
    if (this.newerFileVersion === undefined) return;
    throw new CatalogVersionRefused({
      fileVersion: this.newerFileVersion,
      codeVersion: CATALOG_SCHEMA_VERSION,
      operation,
    });
  }

  /** A newer-schema catalog closes without the WAL checkpoint: zero writes. */
  override close(): void {
    if (this.newerFileVersion === undefined) {
      super.close();
      return;
    }
    if (this.readOnlyClosed) return;
    this.readOnlyClosed = true;
    this.db.close();
  }

  /** Registers a session in the index at fence 0; a lost race is not an error. */
  indexSession(input: SessionIndexInsert): boolean {
    this.refuseNewerSchema("indexSession");
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
   * #1254 S3 ordering law: `has_armed = 1` is written BEFORE the session
   * commit that arms; `has_armed = 0` only after a session transaction
   * confirmed `armed_alarms` is empty. An extra true costs a rescan; a
   * premature false would lose recovery, so only the confirmed-empty path
   * clears it. An unindexed session is not an error here: activation
   * self-heals the index row.
   */
  markArmed(sessionId: string, armed: boolean): void {
    this.refuseNewerSchema("markArmed");
    this.db
      .query("UPDATE session_index SET has_armed = ? WHERE id = ?")
      .run(armed ? 1 : 0, sessionId);
  }

  /** Sessions flagged as possibly holding armed alarms (#1254 S3 boot sweep). */
  armedSessionIds(): readonly string[] {
    return z
      .array(z.object({ id: z.string() }))
      .parse(this.db.query("SELECT id FROM session_index WHERE has_armed = 1 ORDER BY id").all())
      .map((row) => row.id);
  }

  /**
   * Runner-generation fence allocator (W5.2 review F5): one atomic increment
   * under BEGIN IMMEDIATE per entity activation. This only ALLOCATES the next
   * fence number — authority transfers when the winner adopts it into the
   * session file (`adoptFence`), whose lock serializes against every fenced
   * commit; a writer still on an older fence is refused "stale" there by
   * `commitSession`.
   */
  rotateFence(sessionId: string): number {
    this.refuseNewerSchema("rotateFence");
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
  const sink = options.observationSink ?? SILENT_OBSERVATION_SINK;
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  let handle: CatalogStore | undefined;
  try {
    const fileVersion = UserVersion.parse(db.query("PRAGMA user_version").get()).user_version;
    if (fileVersion > CATALOG_SCHEMA_VERSION) {
      // Newer-code file (#1252): no DDL, no file-touching pragma, no marker
      // rewrite — the connection itself is pinned query-only.
      db.run("PRAGMA busy_timeout = 5000");
      db.run("PRAGMA query_only = ON");
      handle = new CatalogStore(db, sink, options.now, fileVersion);
      return handle;
    }
    bootstrapStoreDatabase(db, CATALOG_SCHEMA);
    if (fileVersion === 1) {
      // v1 -> v2 (#1254 S3): the one guarded column add plus the marker, in
      // one transaction. Fresh files get the column from CATALOG_SCHEMA.
      db.transaction(() => {
        db.run("ALTER TABLE session_index ADD COLUMN has_armed INTEGER NOT NULL DEFAULT 0");
        db.run(`PRAGMA user_version = ${CATALOG_SCHEMA_VERSION}`);
      }).immediate();
    } else if (fileVersion < CATALOG_SCHEMA_VERSION) {
      db.run(`PRAGMA user_version = ${CATALOG_SCHEMA_VERSION}`);
    }
    handle = new CatalogStore(db, sink, options.now);
    return handle;
  } finally {
    if (handle === undefined) db.close();
  }
}
