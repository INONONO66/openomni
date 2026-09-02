import type { Database } from "bun:sqlite";
import type { Message, Storage as ProtocolStorage, WorkItem } from "@openomni/protocol";
import { AsyncLocalStorage } from "node:async_hooks";
import { createWorkItemCompletionWriter } from "../work-item/completion-writer.js";
import type { SessionInfo } from "../session/info";
import type { WorkerRunStateStore } from "../worker-run/state-store";

export const productionStorageAdapterBrand: unique symbol = Symbol("productionStorageAdapter");

// Same-process application modules are trusted composition-root code. The completion writer
// prevents accidental bypass through ordinary store APIs; it is not an OS isolation boundary.
export namespace Storage {
  export type WorkItemCompletionWriter = (
    hash: string,
    expectedHead: number,
    item: WorkItem.Info,
  ) => boolean;

  /** One stored transcript fact in immutable session-stream order. */
  export type TranscriptFactRow = {
    sessionID: string;
    seq: number;
    messageID: string;
    attemptID: string;
    type: string;
    data: string;
    timeCreated: number;
  };

  export interface Adapter {
    readonly [productionStorageAdapterBrand]?: true;
    transaction<T>(operation: () => T): T;
    /**
     * Releases the adapter's resources (SQLite: shutdown WAL checkpoint +
     * connection close). Storage.reset() calls it so a reset can never leak
     * an open connection with an unfolded WAL. Must be idempotent — explicit
     * close followed by reset is a supported teardown order.
     */
    close?(): void;
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
    surfaceKey?: ProtocolStorage.SurfaceKeySubAdapter;
    artifact?: {
      store(id: string, sessionId: string, meta: string, content: string): void;
      get(id: string): { meta: string; content: string; sessionId: string } | undefined;
    };
    workItem?: ProtocolStorage.WorkItemSubAdapter;
    // Optional here for narrow test fakes only — Trigger stores fail closed
    // with a typed adapter_absent error when either projection seam is missing.
    trigger?: ProtocolStorage.TriggerSubAdapter;
    triggerFire?: ProtocolStorage.TriggerFireSubAdapter;
    // Optional here for test fakes only — WaitStore fails closed (typed
    // adapter_absent error) when it is missing; production adapters wire it
    // as required (SqliteStorageAdapter).
    wait?: ProtocolStorage.WaitSubAdapter;
    // Optional here for test fakes only — ConversationStore fails closed
    // (typed adapter_absent error) when it is missing; production adapters
    // wire it as required (SqliteStorageAdapter).
    conversation?: ProtocolStorage.ConversationSubAdapter;
    // Optional here for test fakes only — LeaseStore fails closed (typed
    // adapter_absent error) when it is missing; production adapters wire it
    // as required (SqliteStorageAdapter).
    lease?: ProtocolStorage.LeaseSubAdapter;
    approval?: ProtocolStorage.ApprovalSubAdapter;
    // Optional here for test fakes only — EngagementStore fails closed (typed
    // adapter_absent error) when it is missing; production adapters wire it
    // as required (SqliteStorageAdapter). Brain-domain surface (#709): the
    // brain is its sole writer.
    engagement?: ProtocolStorage.EngagementSubAdapter;
    // Optional for test fakes only — DelegationStore fails closed when it is
    // missing; production adapters wire it as required (SqliteStorageAdapter).
    delegation?: ProtocolStorage.DelegationSubAdapter;
    // #510 phase B: decision-class ledger append on the SAME connection as
    // the projection sub-adapters, so a decision-class store can commit
    // append + projection inside one `transaction()` call. Optional for test
    // fakes only — decision-class writers fail closed without it.
    ledger?: ProtocolStorage.LedgerSubAdapter;
    workerRunState?: WorkerRunStateStore.Adapter;
    // Active-egress debit ledger (#219, perimeter domain). Optional for test
    // fakes only — EgressBudgetStore fails closed when it is missing;
    // production adapters wire it as required (SqliteStorageAdapter). Sole
    // writer is the channels gateway router (S8), like the wait store.
    egressBudget?: ProtocolStorage.EgressBudgetSubAdapter;
    actorRegistry?: ProtocolStorage.ActorRegistrySubAdapter;
    blacklist?: ProtocolStorage.BlacklistSubAdapter;
    channelGrant?: ProtocolStorage.ChannelGrantSubAdapter;
    appConnectorInstallation?: ProtocolStorage.AppConnectorInstallationSubAdapter;
    // Provisioning declarations + vault rows (docs/provisioning-and-providers.md
    // §3). Optional for test fakes only — provisioning stores fail closed
    // (typed adapter_absent) when it is missing; production adapters wire it
    // as required (SqliteStorageAdapter).
    provisioning?: ProtocolStorage.ProvisioningSubAdapter;
  }
}

type StorageScope = {
  adapter: Storage.Adapter | null;
  initializedDbPath: string | null;
};

const storageScope = new AsyncLocalStorage<StorageScope>();

export namespace Storage {
  const requiredProductionCapabilities = [
    "session",
    "message",
    "part",
    "transcriptFact",
    "surfaceKey",
    "artifact",
    "workItem",
    "trigger",
    "triggerFire",
    "wait",
    "conversation",
    "lease",
    "approval",
    "engagement",
    "delegation",
    "ledger",
    "workerRunState",
    "egressBudget",
    "actorRegistry",
    "blacklist",
    "channelGrant",
    "appConnectorInstallation",
    "provisioning",
  ] as const satisfies readonly (keyof Adapter)[];

  export type ProductionCapability = (typeof requiredProductionCapabilities)[number];

  class IncompleteAdapterError extends Error {
    readonly code = "incomplete_adapter" as const;

    constructor(readonly capability: ProductionCapability) {
      super(`Production storage adapter is missing required capability: ${capability}`);
      this.name = "IncompleteAdapterError";
    }
  }

  export function assertComplete(adapter: Adapter): void {
    for (const capability of requiredProductionCapabilities) {
      if (adapter[capability] === undefined || adapter[capability] === null) {
        throw new IncompleteAdapterError(capability);
      }
    }
  }

  let adapter: Adapter | null = null;
  let initializedDbPathValue: string | null = null;

  export function configure(newAdapter: Adapter): WorkItemCompletionWriter {
    if (newAdapter[productionStorageAdapterBrand] === true) {
      assertComplete(newAdapter);
    }

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

  export function reset(): void {
    const scope = storageScope.getStore();
    if (scope) {
      // Close BEFORE nulling: dropping the reference without close() leaked
      // the SQLite connection and skipped the shutdown WAL checkpoint.
      scope.adapter?.close?.();
      scope.adapter = null;
      scope.initializedDbPath = null;
      return;
    }
    adapter?.close?.();
    adapter = null;
    initializedDbPathValue = null;
  }

  export function withIsolation<T>(operation: () => T): T {
    return storageScope.run({ adapter: null, initializedDbPath: null }, operation);
  }
}
