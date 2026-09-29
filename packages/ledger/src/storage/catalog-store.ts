import type { Database } from "bun:sqlite";
import type { ObservationSink, Storage as ProtocolStorage } from "@openomni/protocol";
import { z } from "zod";
import { SessionNotFound } from "../errors";
import { CATALOG_SCHEMA } from "./schema-catalog.js";
import { closeStoreDatabase, openStoreDatabase, SILENT_OBSERVATION_SINK } from "./session-store.js";
import { createSqliteActorRegistryAdapter } from "./sqlite-actor-registry-adapter";
import { createSqliteBlacklistAdapter } from "./sqlite-blacklist-adapter";
import { createSqliteChannelGrantAdapter } from "./sqlite-channel-grant-adapter";
import { createSqliteEgressBudgetAdapter } from "./sqlite-egress-budget-adapter";
import { createPolicies } from "./sqlite-l0-policies.js";
import { createSqliteProvisioningAdapter } from "./sqlite-provisioning-adapter";
import { createSqliteReplyGrantAdapter } from "./sqlite-reply-grant-adapter";
import { createSqliteSurfaceKeyAdapter } from "./sqlite-surface-key-adapter";

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
export class CatalogStore {
  readonly observationSink: ObservationSink;
  readonly surfaceKey: ProtocolStorage.SurfaceKeySubAdapter;
  readonly egressBudget: ProtocolStorage.EgressBudgetSubAdapter;
  readonly actorRegistry: ProtocolStorage.ActorRegistrySubAdapter;
  readonly blacklist: ProtocolStorage.BlacklistSubAdapter;
  readonly channelGrant: ProtocolStorage.ChannelGrantSubAdapter;
  readonly replyGrant: ProtocolStorage.ReplyGrantSubAdapter;
  readonly provisioning: ProtocolStorage.ProvisioningSubAdapter;
  readonly policies: ProtocolStorage.PolicyRowSubAdapter;
  readonly transaction = <T>(operation: () => T): T => this.db.transaction(operation).immediate();
  private readonly db: Database;
  private closed = false;

  constructor(db: Database, observationSink: ObservationSink) {
    this.db = db;
    this.observationSink = observationSink;
    this.surfaceKey = createSqliteSurfaceKeyAdapter(db);
    this.egressBudget = createSqliteEgressBudgetAdapter(db);
    this.actorRegistry = createSqliteActorRegistryAdapter(db);
    this.blacklist = createSqliteBlacklistAdapter(db);
    this.channelGrant = createSqliteChannelGrantAdapter(db);
    this.replyGrant = createSqliteReplyGrantAdapter(db);
    this.provisioning = createSqliteProvisioningAdapter(db);
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

  /** Idempotent — explicit teardown and scope finalizers may both close. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeStoreDatabase(this.db);
  }
}

export function openCatalogStore(
  path: string,
  observationSink: ObservationSink = SILENT_OBSERVATION_SINK,
): CatalogStore {
  return new CatalogStore(openStoreDatabase(path, CATALOG_SCHEMA), observationSink);
}
