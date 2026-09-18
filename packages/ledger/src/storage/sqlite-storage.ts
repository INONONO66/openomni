import { Database } from "bun:sqlite";
import { createSqliteDecisionFacts } from "./sqlite-decision-facts";
import { createSqliteActorRegistryAdapter } from "./sqlite-actor-registry-adapter";
import { createSqliteBlacklistAdapter } from "./sqlite-blacklist-adapter";
import { createSqliteChannelGrantAdapter } from "./sqlite-channel-grant-adapter";
import { createSqliteReplyGrantAdapter } from "./sqlite-reply-grant-adapter";
import { createSqliteProvisioningAdapter } from "./sqlite-provisioning-adapter";
import { createSqliteEgressBudgetAdapter } from "./sqlite-egress-budget-adapter";
import { initializeSqliteDatabase } from "./sqlite-schema-lifecycle";
import { createSqliteL0Adapters } from "./sqlite-l0-adapter";
import type { ObservationSink } from "@openomni/protocol";
import { createSqliteSurfaceKeyAdapter } from "./sqlite-surface-key-adapter";
import { productionStorageAdapterBrand, type Storage } from "./storage";

export class SqliteStorageAdapter implements Storage.Adapter {
  declare readonly [productionStorageAdapterBrand]: true;
  private readonly db: Database;
  readonly observationSink: ObservationSink;
  private closed = false;

  readonly surfaceKey: NonNullable<Storage.Adapter["surfaceKey"]>;
  readonly decisionFacts: NonNullable<Storage.Adapter["decisionFacts"]>;
  readonly egressBudget: NonNullable<Storage.Adapter["egressBudget"]>;
  readonly actorRegistry: NonNullable<Storage.Adapter["actorRegistry"]>;
  readonly blacklist: NonNullable<Storage.Adapter["blacklist"]>;
  readonly channelGrant: NonNullable<Storage.Adapter["channelGrant"]>;
  readonly replyGrant: NonNullable<Storage.Adapter["replyGrant"]>;
  readonly provisioning: NonNullable<Storage.Adapter["provisioning"]>;
  readonly sessions: NonNullable<Storage.Adapter["sessions"]>;
  readonly actions: NonNullable<Storage.Adapter["actions"]>;
  readonly inbox: NonNullable<Storage.Adapter["inbox"]>;
  readonly alarms: NonNullable<Storage.Adapter["alarms"]>;
  readonly policies: NonNullable<Storage.Adapter["policies"]>;

  constructor(dbPath: string, observationSink: ObservationSink = { publish: () => undefined }) {
    this.observationSink = observationSink;
    this.db = new Database(dbPath);
    let initialized = false;
    try {
      initializeSqliteDatabase(this.db);
      initialized = true;
    } finally {
      if (!initialized) this.db.close();
    }

    this.surfaceKey = createSqliteSurfaceKeyAdapter(this.db);
    // Facts and projections share this connection and its transaction boundary.
    this.decisionFacts = createSqliteDecisionFacts(this.db);
    this.egressBudget = createSqliteEgressBudgetAdapter(this.db);
    this.actorRegistry = createSqliteActorRegistryAdapter(this.db);
    this.blacklist = createSqliteBlacklistAdapter(this.db);
    this.channelGrant = createSqliteChannelGrantAdapter(this.db);
    this.replyGrant = createSqliteReplyGrantAdapter(this.db);
    this.provisioning = createSqliteProvisioningAdapter(this.db);
    const l0 = createSqliteL0Adapters(
      this.db,
      (operation) => this.transaction(operation),
      observationSink,
    );
    this.sessions = l0.sessions;
    this.actions = l0.actions;
    this.inbox = l0.inbox;
    this.alarms = l0.alarms;
    this.policies = l0.policies;

    // Non-enumerable so object-spread test fakes stay narrow and are not
    // mistaken for the concrete production adapter during Storage.configure.
    Object.defineProperty(this, productionStorageAdapterBrand, { value: true });
  }

  /** Test-only seam for schema/retention characterization; never used by product stores. */
  testDatabase(): Database {
    return this.db;
  }

  transaction<T>(fn: () => T): T {
    // BEGIN IMMEDIATE: every Adapter.transaction caller is a write unit
    // (#510 decision-class discipline) — take the write lock up front
    // instead of upgrading mid-transaction. Nested fact writers use savepoints
    // on this connection, so facts and projections commit as one fsync unit.
    return this.db.transaction(fn).immediate();
  }

  close(): void {
    // Idempotent: Storage.reset() closes too, and explicit close followed by
    // reset is a supported teardown order (test fixtures do both).
    if (this.closed) return;
    this.closed = true;
    // Fold the WAL back into the main file so a cold start reads a clean
    // baseline. This is a no-op for `:memory:` databases.
    this.db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
    this.db.close();
  }
}
