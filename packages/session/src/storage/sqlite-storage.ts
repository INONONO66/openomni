import { Database } from "bun:sqlite";
import { Ledger } from "../ledger-core/index";
import type { WorkerRunStateStore } from "../worker-run/state-store";
import { createSqliteActorRegistryAdapter } from "./sqlite-actor-registry-adapter";
import { createSqliteAppConnectorInstallationAdapter } from "./sqlite-app-connector-installation-adapter";
import { createSqliteBlacklistAdapter } from "./sqlite-blacklist-adapter";
import { createSqliteChannelGrantAdapter } from "./sqlite-channel-grant-adapter";
import { createSqliteArtifactAdapter } from "./sqlite-artifact-adapter";
import { createSqliteCronJobAdapter } from "./sqlite-cron-job-adapter";
import { createSqliteMessageAdapter } from "./sqlite-message-adapter";
import { createSqlitePartAdapter } from "./sqlite-part-adapter";
import { createSqlitePendingAskAdapter } from "./sqlite-pending-ask-adapter";
import { createSqlitePendingInteractionAdapter } from "./sqlite-pending-interaction-adapter";
import {
  clearSqliteStorage,
  initializeSqliteDatabase,
  initializeTelemetryConnection,
} from "./sqlite-schema-lifecycle";
import { createSqliteSessionAdapter } from "./sqlite-session-adapter";
import { createSqliteSurfaceKeyAdapter } from "./sqlite-surface-key-adapter";
import { createSqliteWaitAdapter } from "./sqlite-wait-adapter";
import { createSqliteWorkItemAdapter } from "./sqlite-work-item-adapter";
import { createSqliteWorkerRunStateAdapter } from "./sqlite-worker-run-state-adapter";
import { createSqliteWorkerGrantAdapter } from "./sqlite-worker-grant-adapter";
import type { Storage } from "./storage";

export class SqliteStorageAdapter implements Storage.Adapter {
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

  readonly session: Storage.Adapter["session"];
  readonly message: Storage.Adapter["message"];
  readonly part: Storage.Adapter["part"];
  readonly surfaceKey: NonNullable<Storage.Adapter["surfaceKey"]>;
  readonly artifact: NonNullable<Storage.Adapter["artifact"]>;
  readonly workerRunState: WorkerRunStateStore.Adapter;
  readonly workItem: NonNullable<Storage.Adapter["workItem"]>;
  readonly wait: NonNullable<Storage.Adapter["wait"]>;
  readonly ledger: NonNullable<Storage.Adapter["ledger"]>;
  readonly pendingAsk: NonNullable<Storage.Adapter["pendingAsk"]>;
  readonly pendingInteraction: NonNullable<Storage.Adapter["pendingInteraction"]>;
  readonly workerGrant: NonNullable<Storage.Adapter["workerGrant"]>;
  readonly cronJob: NonNullable<Storage.Adapter["cronJob"]>;
  readonly actorRegistry: NonNullable<Storage.Adapter["actorRegistry"]>;
  readonly blacklist: NonNullable<Storage.Adapter["blacklist"]>;
  readonly channelGrant: NonNullable<Storage.Adapter["channelGrant"]>;
  readonly appConnectorInstallation: NonNullable<Storage.Adapter["appConnectorInstallation"]>;

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
    this.surfaceKey = createSqliteSurfaceKeyAdapter(this.db);
    this.artifact = createSqliteArtifactAdapter(this.db);
    this.workerRunState = createSqliteWorkerRunStateAdapter(this.db);
    this.workItem = createSqliteWorkItemAdapter(this.db);
    this.wait = createSqliteWaitAdapter(this.db);
    // Decision-class append rides the adapter's own connection so append +
    // projection share one transaction (#510 phase B). The append core keeps
    // owning the SQL (raw prepared statements) — this is wiring only.
    this.ledger = {
      append: (event, expectedHead) => Ledger.append(this.db, event, expectedHead),
      headFact: (streamId) => Ledger.headFact(this.db, streamId),
      verifyTail: () => Ledger.verifyTail(this.db),
    };
    this.pendingAsk = createSqlitePendingAskAdapter(this.db);
    this.pendingInteraction = createSqlitePendingInteractionAdapter(this.db);
    this.workerGrant = createSqliteWorkerGrantAdapter(this.db);
    this.cronJob = createSqliteCronJobAdapter(this.db);
    this.actorRegistry = createSqliteActorRegistryAdapter(this.db);
    this.blacklist = createSqliteBlacklistAdapter(this.db);
    this.channelGrant = createSqliteChannelGrantAdapter(this.db);
    this.appConnectorInstallation = createSqliteAppConnectorInstallationAdapter(this.db);
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
