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
import {
  clearSqliteStorage,
  initializeSqliteDatabase,
  initializeTelemetryConnection,
} from "./sqlite-schema-lifecycle";
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
  /**
   * #510 D1 durability split: NORMAL/group-commit telemetry connection on
   * the SAME database file. bus-persistence writes ride this connection so
   * a telemetry write can never join a decision-class transaction — the
   * decision path stays synchronous=FULL on `db`. Writer serialization
   * between the two connections is WAL + per-connection busy_timeout.
   * For `:memory:` this IS `db` (an in-memory database cannot be shared
   * across connections), so the split degrades to the single connection.
   */
  private readonly telemetryDb: Database;
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

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    try {
      initializeSqliteDatabase(this.db);
    } catch (err) {
      this.db.close();
      throw err;
    }

    if (dbPath === ":memory:") {
      this.telemetryDb = this.db;
    } else {
      this.telemetryDb = new Database(dbPath);
      try {
        initializeTelemetryConnection(this.telemetryDb);
      } catch (err) {
        this.telemetryDb.close();
        this.db.close();
        throw err;
      }
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

    // Non-enumerable so object-spread test fakes stay narrow and are not
    // mistaken for the concrete production adapter during Storage.configure.
    Object.defineProperty(this, productionStorageAdapterBrand, { value: true });
  }

  /**
   * #510 D1: the sanctioned accessor to the telemetry connection for
   * bus-persistence — never exposes the private handle for casting. Always the
   * telemetry connection (which IS `db` for `:memory:`), so it already encodes
   * the "prefer telemetry, fall back to primary" resolution.
   */
  telemetryConnection(): Database {
    return this.telemetryDb;
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
    if (this.telemetryDb !== this.db) {
      this.telemetryDb.close();
    }
    // Shutdown checkpoint (#510 D1 accepted-append drain): fold the WAL back
    // into the main file so a cold start reads a clean baseline. Runs after
    // the telemetry connection closed (no reader pins the WAL) and is a
    // no-op for `:memory:` (never in WAL mode).
    this.db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
    this.db.close();
  }
}
