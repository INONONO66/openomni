import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { Ledger } from "@openomni/protocol";
import { initializeSqliteDatabase } from "../storage/sqlite-schema-lifecycle.js";
import { type ArtifactBlob, type ArtifactBlobHash, readArtifactBlob } from "./blob.js";
import {
  createProductionLedgerProjections,
  rebuildProductionLedgerProjections,
} from "./projection.js";
import { createLedgerQuery, createScopedLedgerQuery, type LedgerQuery } from "./query.js";
import { type AppendOptions, createLedgerWriter, type LedgerWriter } from "./writer.js";

const TOTAL_QUEUE_LIMIT = 1_024;
const PRINCIPAL_QUEUE_LIMIT = 64;
const writableDatabases = new Set<string>();

export interface OpenLedgerRuntimeOptions {
  readonly dbPath: string;
}

export interface LedgerRuntimeAppendOptions extends AppendOptions {
  readonly signal?: AbortSignal;
}

export interface LedgerRuntime {
  append(
    batch: Ledger.AppendBatch,
    options?: LedgerRuntimeAppendOptions,
  ): Promise<Ledger.AppendResult>;
  query<T>(callback: (query: LedgerQuery) => T): Promise<T>;
  readBlob(hash: ArtifactBlobHash): Promise<ArtifactBlob | undefined>;
  close(): Promise<void>;
}

export class LedgerRuntimePathInUseError extends Error {
  readonly code = "ledger_runtime_path_in_use" as const;

  constructor(readonly dbPath: string) {
    super(`A writable ledger runtime is already open for ${dbPath}`);
    this.name = "LedgerRuntimePathInUseError";
  }
}

export class LedgerRuntimeClosedError extends Error {
  readonly code = "ledger_runtime_closed" as const;

  constructor() {
    super("Ledger runtime is closed");
    this.name = "LedgerRuntimeClosedError";
  }
}

export class LedgerRuntimeQueueFullError extends Error {
  readonly code = "ledger_runtime_queue_full" as const;

  constructor(
    readonly scope: "total" | "principal",
    readonly principalId: string,
    readonly limit: number,
  ) {
    super(`Ledger append queue ${scope} limit of ${limit} was reached`);
    this.name = "LedgerRuntimeQueueFullError";
  }
}

export class LedgerRuntimeAppendCancelledError extends Error {
  readonly code = "ledger_runtime_append_cancelled" as const;

  constructor(readonly principalId: string) {
    super("Ledger append was cancelled before dequeue");
    this.name = "LedgerRuntimeAppendCancelledError";
  }
}

export class LedgerRuntimeAsyncQueryError extends Error {
  readonly code = "ledger_runtime_async_query" as const;

  constructor() {
    super("Ledger query callbacks must complete synchronously");
    this.name = "LedgerRuntimeAsyncQueryError";
  }
}

/** Opens and exclusively owns the process's sole writable handle for this database. */
export function openLedgerRuntime(options: OpenLedgerRuntimeOptions): LedgerRuntime {
  let db: Database | undefined;
  let databaseIdentity: string | undefined;
  let ownsExclusiveLock = false;
  databaseIdentity = existingDatabaseIdentity(options.dbPath);
  if (databaseIdentity !== undefined && writableDatabases.has(databaseIdentity)) {
    throw new LedgerRuntimePathInUseError(options.dbPath);
  }
  try {
    const openedDb = new Database(options.dbPath, { strict: true, create: true });
    db = openedDb;
    databaseIdentity ??= openedDatabaseIdentity(openedDb);
    const acquiredDatabaseIdentity = databaseIdentity;
    if (writableDatabases.has(acquiredDatabaseIdentity)) {
      throw new LedgerRuntimePathInUseError(options.dbPath);
    }
    writableDatabases.add(acquiredDatabaseIdentity);

    initializeSqliteDatabase(openedDb);
    acquireLifetimeExclusiveLock(openedDb);
    ownsExclusiveLock = true;
    const projections = createProductionLedgerProjections(openedDb);
    rebuildProductionLedgerProjections(openedDb, projections);
    const owned = new OwnedLedgerRuntime(
      openedDb,
      createLedgerWriter(openedDb, projections),
      createLedgerQuery(openedDb),
      () => writableDatabases.delete(acquiredDatabaseIdentity),
    );
    return Object.freeze({
      append: (batch: Ledger.AppendBatch, appendOptions?: LedgerRuntimeAppendOptions) =>
        owned.append(batch, appendOptions),
      query: <T>(callback: (query: LedgerQuery) => T) => owned.query(callback),
      readBlob: (hash: ArtifactBlobHash) => owned.readBlob(hash),
      close: () => owned.close(),
    });
  } catch (error) {
    try {
      if (db !== undefined) closeDatabase(db, ownsExclusiveLock);
    } finally {
      if (databaseIdentity !== undefined) writableDatabases.delete(databaseIdentity);
    }
    throw error;
  }
}

function existingDatabaseIdentity(dbPath: string): string | undefined {
  if (dbPath === ":memory:" || !existsSync(dbPath)) return undefined;
  return fileIdentity(realpathSync(dbPath));
}

function openedDatabaseIdentity(db: Database): string {
  if (db.filename === ":memory:") return `memory:${randomUUID()}`;
  return fileIdentity(realpathSync(db.filename));
}

function fileIdentity(canonicalPath: string): string {
  const { dev, ino } = statSync(canonicalPath);
  return `${dev}:${ino}`;
}

function acquireLifetimeExclusiveLock(db: Database): void {
  db.query("PRAGMA locking_mode = EXCLUSIVE").get();
  db.exec("BEGIN EXCLUSIVE TRANSACTION; COMMIT");
}

function closeDatabase(db: Database, ownsExclusiveLock = true): void {
  if (ownsExclusiveLock) db.query("PRAGMA locking_mode = NORMAL").get();
  const clearQueryCache = Reflect.get(db, "clearQueryCache");
  if (typeof clearQueryCache === "function") Reflect.apply(clearQueryCache, db, []);
  Bun.gc(true);
  db.close();
}

interface QueuedAppend {
  readonly batch: Ledger.AppendBatch;
  readonly options: AppendOptions;
  readonly principalId: string;
  readonly resolve: (result: Ledger.AppendResult) => void;
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal;
  readonly onAbort: () => void;
  queued: boolean;
}

class OwnedLedgerRuntime implements LedgerRuntime {
  private readonly queues = new Map<string, QueuedAppend[]>();
  private readonly principalOrder: string[] = [];
  private pending = 0;
  private drainScheduled = false;
  private appendActive = false;
  private closing = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private resolveClose: (() => void) | undefined;
  private rejectClose: ((error: unknown) => void) | undefined;

  constructor(
    private readonly db: Database,
    private writer: LedgerWriter | undefined,
    private ledgerQuery: LedgerQuery | undefined,
    private readonly releasePath: () => void,
  ) {}

  append(
    batch: Ledger.AppendBatch,
    options: LedgerRuntimeAppendOptions = {},
  ): Promise<Ledger.AppendResult> {
    if (this.closing || this.closed) return Promise.reject(new LedgerRuntimeClosedError());
    let request: Ledger.AppendBatch;
    try {
      request = Ledger.AppendBatch.parse(batch);
    } catch (error) {
      return Promise.reject(error);
    }
    const principalId = request.principalId;
    if (options.signal?.aborted === true) {
      return Promise.reject(new LedgerRuntimeAppendCancelledError(principalId));
    }
    if (this.pending >= TOTAL_QUEUE_LIMIT) {
      return Promise.reject(
        new LedgerRuntimeQueueFullError("total", principalId, TOTAL_QUEUE_LIMIT),
      );
    }
    const existing = this.queues.get(principalId);
    if ((existing?.length ?? 0) >= PRINCIPAL_QUEUE_LIMIT) {
      return Promise.reject(
        new LedgerRuntimeQueueFullError("principal", principalId, PRINCIPAL_QUEUE_LIMIT),
      );
    }

    const writerOptions = copyAppendOptions(options);
    return new Promise((resolveAppend, rejectAppend) => {
      const queue = existing ?? [];
      let entry: QueuedAppend;
      const onAbort = (): void => this.cancelQueued(entry);
      entry = {
        batch: request,
        options: writerOptions,
        principalId,
        resolve: resolveAppend,
        reject: rejectAppend,
        signal: options.signal,
        onAbort,
        queued: true,
      };
      queue.push(entry);
      if (existing === undefined) {
        this.queues.set(principalId, queue);
        this.principalOrder.push(principalId);
      }
      this.pending += 1;
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.scheduleDrain();
    });
  }

  async query<T>(callback: (query: LedgerQuery) => T): Promise<T> {
    this.assertOpen();
    const ledgerQuery = this.ledgerQuery;
    if (ledgerQuery === undefined) throw new LedgerRuntimeClosedError();
    const scoped = createScopedLedgerQuery(ledgerQuery);
    try {
      const result = callback(scoped.capability);
      if (isThenable(result)) throw new LedgerRuntimeAsyncQueryError();
      return result;
    } finally {
      scoped.invalidate();
    }
  }

  async readBlob(hash: ArtifactBlobHash): Promise<ArtifactBlob | undefined> {
    this.assertOpen();
    return readArtifactBlob(this.db, hash);
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closing = true;
    this.closePromise = new Promise<void>((resolveClose, rejectClose) => {
      this.resolveClose = resolveClose;
      this.rejectClose = rejectClose;
    });
    this.rejectQueued(new LedgerRuntimeClosedError());
    this.finishCloseIfIdle();
    return this.closePromise;
  }

  private assertOpen(): void {
    if (this.closing || this.closed) throw new LedgerRuntimeClosedError();
  }

  private cancelQueued(entry: QueuedAppend): void {
    if (!entry.queued) return;
    const queue = this.queues.get(entry.principalId);
    if (queue === undefined) return;
    const index = queue.indexOf(entry);
    if (index < 0) return;
    queue.splice(index, 1);
    entry.queued = false;
    this.pending -= 1;
    if (queue.length === 0) this.removePrincipal(entry.principalId);
    entry.reject(new LedgerRuntimeAppendCancelledError(entry.principalId));
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.appendActive || this.closing || this.pending === 0) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this.drainOne();
    });
  }

  private drainOne(): void {
    if (this.closing || this.appendActive) return;
    const principalId = this.principalOrder.shift();
    if (principalId === undefined) return;
    const queue = this.queues.get(principalId);
    const entry = queue?.shift();
    if (queue === undefined || entry === undefined) {
      this.queues.delete(principalId);
      this.scheduleDrain();
      return;
    }
    if (queue.length === 0) this.queues.delete(principalId);
    else this.principalOrder.push(principalId);

    entry.queued = false;
    this.pending -= 1;
    entry.signal?.removeEventListener("abort", entry.onAbort);
    this.appendActive = true;
    try {
      const writer = this.writer;
      if (writer === undefined) throw new LedgerRuntimeClosedError();
      entry.resolve(writer.append(entry.batch, entry.options));
    } catch (error) {
      entry.reject(error);
    } finally {
      this.appendActive = false;
      this.finishCloseIfIdle();
      this.scheduleDrain();
    }
  }

  private rejectQueued(error: Error): void {
    for (const queue of this.queues.values()) {
      for (const entry of queue) {
        entry.queued = false;
        entry.signal?.removeEventListener("abort", entry.onAbort);
        entry.reject(error);
      }
    }
    this.queues.clear();
    this.principalOrder.length = 0;
    this.pending = 0;
  }

  private removePrincipal(principalId: string): void {
    this.queues.delete(principalId);
    const orderIndex = this.principalOrder.indexOf(principalId);
    if (orderIndex >= 0) this.principalOrder.splice(orderIndex, 1);
  }

  private finishCloseIfIdle(): void {
    if (!this.closing || this.appendActive || this.closed) return;
    this.closed = true;
    try {
      this.writer = undefined;
      this.ledgerQuery = undefined;
      closeDatabase(this.db);
      this.releasePath();
      this.resolveClose?.();
    } catch (error) {
      this.releasePath();
      this.rejectClose?.(error);
    }
  }
}

function copyAppendOptions(options: AppendOptions): AppendOptions {
  if (options.artifactBlobs === undefined) return Object.freeze({});
  const artifactBlobs = options.artifactBlobs.map(({ bytes, expectedHash }) =>
    Object.freeze({
      bytes: bytes.slice(),
      ...(expectedHash === undefined ? {} : { expectedHash }),
    }),
  );
  return Object.freeze({ artifactBlobs: Object.freeze(artifactBlobs) });
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    ((typeof value === "object" && value !== null) || typeof value === "function") &&
    "then" in value
  );
}
