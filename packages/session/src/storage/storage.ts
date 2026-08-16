import type { Database } from "bun:sqlite";
import type { Message, Storage as ProtocolStorage, WorkItem } from "@openomni/protocol";
import { AsyncLocalStorage } from "node:async_hooks";
import { createWorkItemCompletionWriter } from "../work-item/completion-writer.js";
import type { SessionInfo } from "../session/info";
import type { WorkerRunStateStore } from "../worker-run/state-store";

// Same-process application modules are trusted composition-root code. The completion writer
// prevents accidental bypass through ordinary store APIs; it is not an OS isolation boundary.
export namespace Storage {
  export type WorkItemCompletionWriter = (
    hash: string,
    expectedHead: number,
    item: WorkItem.Info,
  ) => boolean;

  /** One stored transcript fact: session-stream seq + the fact's JSON bytes. */
  export type TranscriptFactRow = {
    seq: number;
    data: string;
  };

  export interface Adapter {
    transaction<T>(operation: () => T): T;
    /**
     * #510 D1: the telemetry connection (NORMAL/group-commit) that
     * bus-persistence reads and writes ride — the sanctioned accessor for the
     * underlying SQLite handle so consumers never cast past `private` fields
     * to reach it. Returns the primary connection when no split exists
     * (`:memory:`). Absent on non-SQLite adapters; BusPersistence fails closed
     * (getDatabase throws) or degrades to a no-op (getOptionalDatabase).
     */
    telemetryConnection?(): Database;
    session: {
      get(id: string): SessionInfo | undefined;
      set(id: string, info: SessionInfo): void;
      list(): SessionInfo[];
      remove(id: string): boolean;
    };
    message: {
      get(sessionID: string, messageID: string): Message.Info | undefined;
      set(sessionID: string, message: Message.Info): void;
      list(sessionID: string): Message.Info[];
      remove(sessionID: string, messageID: string): boolean;
      setStatus?(messageID: string, status: string): void;
      findByStatus?(status: string): Array<{ id: string; sessionId: string }>;
    };
    part: {
      get(messageID: string, partID: string): Message.Part | undefined;
      set(messageID: string, part: Message.Part): void;
      list(messageID: string): Message.Part[];
      remove(messageID: string, partID: string): boolean;
    };
    // #547 C3: append-only Transcript.Fact rows (recording tier). The surface
    // is deliberately append + read ONLY — a recorded fact is immutable and
    // later lifecycle steps are NEW facts (part.advanced), never updates of
    // stored rows. Optional here for test fakes only — TranscriptStore fails
    // closed when it is missing; production adapters wire it as required
    // (SqliteStorageAdapter).
    transcriptFact?: {
      append(row: {
        sessionID: string;
        messageID: string;
        attemptID: string;
        type: string;
        data: string;
        timeCreated: number;
      }): number;
      list(sessionID: string): TranscriptFactRow[];
      listByAttempt(sessionID: string, attemptID: string): TranscriptFactRow[];
      /**
       * #562 F7: stored-fact count for one attempt — the record path's
       * continuity check for its in-memory fold-state cache (an index count,
       * never a row read). Still read-only surface: no update, no delete.
       */
      countByAttempt(sessionID: string, attemptID: string): number;
    };

    // Optional here for test fakes only — SurfaceKey operations fail closed
    // (requireSubAdapter throw) when it is missing; production adapters wire
    // it as required (SqliteStorageAdapter).
    surfaceKey?: {
      claim(key: string, sessionId: string, expectedSessionId?: string): string;
      lookup(key: string): string | undefined;
      listBySession(sessionId: string): string[];
    };
    artifact?: {
      store(id: string, sessionId: string, meta: string, content: string): void;
      get(id: string): { meta: string; content: string; sessionId: string } | undefined;
    };
    workItem?: ProtocolStorage.WorkItemSubAdapter;
    // Optional here for test fakes only — WaitStore fails closed (typed
    // adapter_absent error) when it is missing; production adapters wire it
    // as required (SqliteStorageAdapter).
    wait?: ProtocolStorage.WaitSubAdapter;
    // #510 phase B: decision-class ledger append on the SAME connection as
    // the projection sub-adapters, so a decision-class store can commit
    // append + projection inside one `transaction()` call. Optional for test
    // fakes only — decision-class writers fail closed without it.
    ledger?: ProtocolStorage.LedgerSubAdapter;
    workerRunState?: WorkerRunStateStore.Adapter;
    pendingAsk?: ProtocolStorage.PendingAskSubAdapter;
    pendingInteraction?: ProtocolStorage.PendingInteractionSubAdapter;
    workerGrant?: ProtocolStorage.WorkerGrantSubAdapter;
    cronJob?: ProtocolStorage.CronJobSubAdapter;
    actorRegistry?: ProtocolStorage.ActorRegistrySubAdapter;
    blacklist?: ProtocolStorage.BlacklistSubAdapter;
    channelGrant?: ProtocolStorage.ChannelGrantSubAdapter;
    appConnectorInstallation?: ProtocolStorage.AppConnectorInstallationSubAdapter;
  }
}

type StorageScope = {
  adapter: Storage.Adapter | null;
  initializedDbPath: string | null;
};

const storageScope = new AsyncLocalStorage<StorageScope>();

export namespace Storage {
  let adapter: Adapter | null = null;
  let initializedDbPathValue: string | null = null;

  export function configure(newAdapter: Adapter): WorkItemCompletionWriter {
    const scope = storageScope.getStore();
    if (scope) {
      scope.adapter = newAdapter;
      scope.initializedDbPath = "__configured__";
      return createWorkItemCompletionWriter(() => Storage.get());
    }
    adapter = newAdapter;
    initializedDbPathValue = "__configured__";
    return createWorkItemCompletionWriter(() => Storage.get());
  }

  export function getInitializedDbPath(): string | null {
    const scope = storageScope.getStore();
    return scope ? scope.initializedDbPath : initializedDbPathValue;
  }

  export function setInitializedDbPath(dbPath: string | null): void {
    const scope = storageScope.getStore();
    if (scope) {
      scope.initializedDbPath = dbPath;
      return;
    }
    initializedDbPathValue = dbPath;
  }

  // Decision-class stores fail closed (#522): an uninitialized Storage is a
  // typed boot-order bug, never a silent volatile ":memory:" fallback.
  export function get(): Adapter {
    const scope = storageScope.getStore();
    const current = scope ? scope.adapter : adapter;
    if (current === null) {
      throw new Error(
        'Storage.get() called before initialize() — storage fails closed with no in-memory fallback. Call Storage.initialize({ dbPath }) at app entry (tests: initialize({ dbPath: ":memory:" }) or Storage.configure(adapter)).',
      );
    }
    return current;
  }

  export function getAdapter(): Adapter {
    return get();
  }

  export function reset(): void {
    const scope = storageScope.getStore();
    if (scope) {
      scope.adapter = null;
      scope.initializedDbPath = null;
      return;
    }
    adapter = null;
    initializedDbPathValue = null;
  }

  export function withIsolation<T>(operation: () => T): T {
    return storageScope.run({ adapter: null, initializedDbPath: null }, operation);
  }
}
