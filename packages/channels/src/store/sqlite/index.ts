import type { Database } from "bun:sqlite";
import type { Storage as ProtocolStorage } from "@openomni/protocol";
import { applyChannelStoreSchema } from "./schema.js";
import { createSqliteActorRegistryAdapter } from "./sqlite-actor-registry-adapter.js";
import { createSqliteBlacklistAdapter } from "./sqlite-blacklist-adapter.js";
import { createSqliteChannelGrantAdapter } from "./sqlite-channel-grant-adapter.js";
import { createSqliteEgressBudgetAdapter } from "./sqlite-egress-budget-adapter.js";
import { createSqliteProvisioningAdapter } from "./sqlite-provisioning-adapter.js";
import { createSqliteReplyGrantAdapter } from "./sqlite-reply-grant-adapter.js";
import { createSqliteSurfaceKeyAdapter } from "./sqlite-surface-key-adapter.js";

/**
 * The channels-owned durable store plane (#1317): the seven channel-facing
 * SQLite adapters plus the handle-bound write transaction, over one database
 * handle the composition root opens (in production, the same file as the
 * agent catalog). The agent catalog constructs none of this.
 */
export interface ChannelStore {
  readonly actorRegistry: ProtocolStorage.ActorRegistrySubAdapter;
  readonly blacklist: ProtocolStorage.BlacklistSubAdapter;
  readonly channelGrant: ProtocolStorage.ChannelGrantSubAdapter;
  readonly replyGrant: ProtocolStorage.ReplyGrantSubAdapter;
  readonly egressBudget: ProtocolStorage.EgressBudgetSubAdapter;
  readonly surfaceKey: ProtocolStorage.SurfaceKeySubAdapter;
  readonly provisioning: ProtocolStorage.ProvisioningSubAdapter;
  /** Injected wall clock (#1245): the store plane never reads ambient time. */
  readonly now: () => number;
  transaction<T>(operation: () => T): T;
}

/** Applies the channel-store schema and binds the seven adapters to `db`. */
export function openChannelStore(db: Database, now: () => number): ChannelStore {
  applyChannelStoreSchema(db);
  return {
    actorRegistry: createSqliteActorRegistryAdapter(db, now),
    blacklist: createSqliteBlacklistAdapter(db, now),
    channelGrant: createSqliteChannelGrantAdapter(db, now),
    replyGrant: createSqliteReplyGrantAdapter(db),
    egressBudget: createSqliteEgressBudgetAdapter(db, now),
    surfaceKey: createSqliteSurfaceKeyAdapter(db, now),
    provisioning: createSqliteProvisioningAdapter(db, now),
    now,
    // Every transaction caller is a write unit: take the write lock up front
    // (BEGIN IMMEDIATE) instead of upgrading mid-transaction.
    transaction: <T>(operation: () => T): T => db.transaction(operation).immediate(),
  };
}
