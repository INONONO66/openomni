import { Database } from "bun:sqlite";
import { Ledger } from "../ledger-core/index";
import type { WorkerRunStateStore } from "../worker-run/state-store";
import { createSqliteActorRegistryAdapter } from "./sqlite-actor-registry-adapter";
import { createSqliteAppConnectorInstallationAdapter } from "./sqlite-app-connector-installation-adapter";
import { createSqliteBlacklistAdapter } from "./sqlite-blacklist-adapter";
import { createSqliteChannelGrantAdapter } from "./sqlite-channel-grant-adapter";
import { createSqliteProvisioningAdapter } from "./sqlite-provisioning-adapter";
import { createSqliteEgressBudgetAdapter } from "./sqlite-egress-budget-adapter";
import { createSqliteDelegationAdapter } from "./sqlite-delegation-adapter";
import { createSqliteMessageAdapter } from "./sqlite-message-adapter";
import { createSqlitePartAdapter } from "./sqlite-part-adapter";
import { clearSqliteStorage, initializeSqliteDatabase } from "./sqlite-schema-lifecycle";
import { createSqliteL0Adapters } from "./sqlite-l0-adapter";
import type { ObservationSink } from "@openomni/protocol";
import { createSqliteSessionAdapter } from "./sqlite-session-adapter";
import { createSqliteSurfaceKeyAdapter } from "./sqlite-surface-key-adapter";
import { createSqliteTranscriptFactAdapter } from "./sqlite-transcript-fact-adapter";
import { createSqliteApprovalAdapter } from "./sqlite-approval-adapter";
import { createSqliteWaitAdapter } from "./sqlite-wait-adapter";
import { createSqliteWorkerRunStateAdapter } from "./sqlite-worker-run-state-adapter";
import { productionStorageAdapterBrand, type Storage } from "./storage";

export class SqliteStorageAdapter implements Storage.Adapter {
  declare readonly [productionStorageAdapterBrand]: true;
  private readonly db: Database;
  readonly observationSink: ObservationSink;
  private closed = false;

  readonly session: Storage.Adapter["session"];
  readonly message: Storage.Adapter["message"];
  readonly part: Storage.Adapter["part"];
  readonly transcriptFact: NonNullable<Storage.Adapter["transcriptFact"]>;
  readonly surfaceKey: NonNullable<Storage.Adapter["surfaceKey"]>;
  readonly workerRunState: WorkerRunStateStore.Adapter;
  readonly wait: NonNullable<Storage.Adapter["wait"]>;
  readonly approval: NonNullable<Storage.Adapter["approval"]>;
  readonly delegation: NonNullable<Storage.Adapter["delegation"]>;
  readonly ledger: NonNullable<Storage.Adapter["ledger"]>;
  readonly egressBudget: NonNullable<Storage.Adapter["egressBudget"]>;
  readonly actorRegistry: NonNullable<Storage.Adapter["actorRegistry"]>;
  readonly blacklist: NonNullable<Storage.Adapter["blacklist"]>;
  readonly channelGrant: NonNullable<Storage.Adapter["channelGrant"]>;
  readonly appConnectorInstallation: NonNullable<Storage.Adapter["appConnectorInstallation"]>;
  readonly provisioning: NonNullable<Storage.Adapter["provisioning"]>;
  readonly sessions: NonNullable<Storage.Adapter["sessions"]>;
  readonly actions: NonNullable<Storage.Adapter["actions"]>;
  readonly inbox: NonNullable<Storage.Adapter["inbox"]>;
  readonly alarms: NonNullable<Storage.Adapter["alarms"]>;
  readonly policies: NonNullable<Storage.Adapter["policies"]>;

  constructor(dbPath: string, observationSink: ObservationSink = { publish: () => undefined }) {
    this.observationSink = observationSink;
    this.db = new Database(dbPath);
    try {
      initializeSqliteDatabase(this.db);
    } catch (err) {
      this.db.close();
      throw err;
    }

    this.session = createSqliteSessionAdapter(this.db);
    this.message = createSqliteMessageAdapter(this.db);
    this.part = createSqlitePartAdapter(this.db);
    // Transcript facts share the primary connection: the record path commits
    // fact append + message/part projection inside one transaction (#547 C3).
    this.transcriptFact = createSqliteTranscriptFactAdapter(this.db);
    this.surfaceKey = createSqliteSurfaceKeyAdapter(this.db);
    this.workerRunState = createSqliteWorkerRunStateAdapter(this.db);
    this.wait = createSqliteWaitAdapter(this.db);
    this.approval = createSqliteApprovalAdapter(this.db);
    this.delegation = createSqliteDelegationAdapter(this.db);
    // Decision-class append rides the adapter's own connection so append +
    // projection share one transaction (#510 phase B). The append core keeps
    // owning the SQL (raw prepared statements) — this is wiring only.
    this.ledger = {
      append: (event, expectedHead) => Ledger.append(this.db, event, expectedHead),
      adoptStream: (streamId, headRevision, genesis) =>
        Ledger.adoptStream(this.db, streamId, headRevision, genesis),
      headFact: (streamId) => Ledger.headFact(this.db, streamId),
      factsByType: (type) => Ledger.factsByType(this.db, type),
    };
    this.egressBudget = createSqliteEgressBudgetAdapter(this.db);
    this.actorRegistry = createSqliteActorRegistryAdapter(this.db);
    this.blacklist = createSqliteBlacklistAdapter(this.db);
    this.channelGrant = createSqliteChannelGrantAdapter(this.db);
    this.appConnectorInstallation = createSqliteAppConnectorInstallationAdapter(this.db);
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

  clear(): void {
    clearSqliteStorage(this.db);
  }

  transaction<T>(fn: () => T): T {
    // BEGIN IMMEDIATE: every Adapter.transaction caller is a write unit
    // (#510 decision-class discipline) — take the write lock up front
    // instead of upgrading mid-transaction. Nested writers (e.g. the ledger
    // append core's own transaction) degrade to savepoints on this one
    // connection, so append + projection commit as a single fsync unit.
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
