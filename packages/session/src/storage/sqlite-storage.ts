import { Database } from "bun:sqlite";
import type { WorkerRunStateStore } from "../worker-run/state-store";
import { createSqliteActorRegistryAdapter } from "./sqlite-actor-registry-adapter";
import { createSqliteBlacklistAdapter } from "./sqlite-blacklist-adapter";
import { createSqliteArtifactAdapter } from "./sqlite-artifact-adapter";
import { createSqliteBackgroundTaskAdapter } from "./sqlite-background-task-adapter";
import { createSqliteCronJobAdapter } from "./sqlite-cron-job-adapter";
import { createSqliteMessageAdapter } from "./sqlite-message-adapter";
import { createSqlitePartAdapter } from "./sqlite-part-adapter";
import { createSqlitePendingAskAdapter } from "./sqlite-pending-ask-adapter";
import { clearSqliteStorage, initializeSqliteDatabase } from "./sqlite-schema-lifecycle";
import { createSqliteSessionAdapter } from "./sqlite-session-adapter";
import { createSqliteSurfaceKeyAdapter } from "./sqlite-surface-key-adapter";
import { createSqliteWorkItemAdapter } from "./sqlite-work-item-adapter";
import { createSqliteWorkerRunStateAdapter } from "./sqlite-worker-run-state-adapter";
import { createSqliteWorkerGrantAdapter } from "./sqlite-worker-grant-adapter";
import type { Storage } from "./storage";

export class SqliteStorageAdapter implements Storage.Adapter {
  private readonly db: Database;

  readonly session: Storage.Adapter["session"];
  readonly message: Storage.Adapter["message"];
  readonly part: Storage.Adapter["part"];
  readonly surfaceKey: NonNullable<Storage.Adapter["surfaceKey"]>;
  readonly artifact: NonNullable<Storage.Adapter["artifact"]>;
  readonly backgroundTask: NonNullable<Storage.Adapter["backgroundTask"]>;
  readonly workerRunState: WorkerRunStateStore.Adapter;
  readonly workItem: NonNullable<Storage.Adapter["workItem"]>;
  readonly pendingAsk: NonNullable<Storage.Adapter["pendingAsk"]>;
  readonly workerGrant: NonNullable<Storage.Adapter["workerGrant"]>;
  readonly cronJob: NonNullable<Storage.Adapter["cronJob"]>;
  readonly actorRegistry: NonNullable<Storage.Adapter["actorRegistry"]>;
  readonly blacklist: NonNullable<Storage.Adapter["blacklist"]>;

  constructor(dbPath: string) {
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
    this.surfaceKey = createSqliteSurfaceKeyAdapter(this.db);
    this.artifact = createSqliteArtifactAdapter(this.db);
    this.backgroundTask = createSqliteBackgroundTaskAdapter(this.db);
    this.workerRunState = createSqliteWorkerRunStateAdapter(this.db);
    this.workItem = createSqliteWorkItemAdapter(this.db);
    this.pendingAsk = createSqlitePendingAskAdapter(this.db);
    this.workerGrant = createSqliteWorkerGrantAdapter(this.db);
    this.cronJob = createSqliteCronJobAdapter(this.db);
    this.actorRegistry = createSqliteActorRegistryAdapter(this.db);
    this.blacklist = createSqliteBlacklistAdapter(this.db);
  }

  clear(): void {
    clearSqliteStorage(this.db);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}
