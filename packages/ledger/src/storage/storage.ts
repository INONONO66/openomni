import type { BusEvent, Storage as ProtocolStorage } from "@openomni/protocol";
import { AsyncLocalStorage } from "node:async_hooks";

export const productionStorageAdapterBrand: unique symbol = Symbol("productionStorageAdapter");

// Same-process application modules are trusted composition-root code. The completion writer
// prevents accidental bypass through ordinary store APIs; it is not an OS isolation boundary.
export namespace Storage {
  export interface Adapter {
    readonly [productionStorageAdapterBrand]?: true;
    readonly observationSink?: BusEvent.Sink;
    transaction<T>(operation: () => T): T;
    /**
     * Releases the adapter's resources (SQLite: shutdown WAL checkpoint +
     * connection close). Storage.reset() calls it so a reset can never leak
     * an open connection with an unfolded WAL. Must be idempotent — explicit
     * close followed by reset is a supported teardown order.
     */
    close?(): void;
    // Optional here for test fakes only — SurfaceKey operations fail closed
    // (requireSubAdapter throw) when it is missing; production adapters wire
    // it as required (SqliteStorageAdapter).
    surfaceKey?: ProtocolStorage.SurfaceKeySubAdapter;

    // Optional here for test fakes only — WaitStore fails closed (typed
    // adapter_absent error) when it is missing; production adapters wire it
    // as required (SqliteStorageAdapter).
    wait?: ProtocolStorage.WaitSubAdapter;
    approval?: ProtocolStorage.ApprovalSubAdapter;
    // #510 phase B: decision-class ledger append on the SAME connection as
    // the projection sub-adapters, so a decision-class store can commit
    // append + projection inside one `transaction()` call. Optional for test
    // fakes only — decision-class writers fail closed without it.
    ledger?: ProtocolStorage.LedgerSubAdapter;
    // Active-egress debit ledger (#219, perimeter domain). Optional for test
    // fakes only — EgressBudgetStore fails closed when it is missing;
    // production adapters wire it as required (SqliteStorageAdapter). Sole
    // writer is the channels gateway router (S8), like the wait store.
    egressBudget?: ProtocolStorage.EgressBudgetSubAdapter;
    actorRegistry?: ProtocolStorage.ActorRegistrySubAdapter;
    blacklist?: ProtocolStorage.BlacklistSubAdapter;
    channelGrant?: ProtocolStorage.ChannelGrantSubAdapter;
    replyGrant?: ProtocolStorage.ReplyGrantSubAdapter;
    // Provisioning declarations + vault rows (docs/provisioning-and-providers.md
    // §3). Optional for test fakes only — provisioning stores fail closed
    // (typed adapter_absent) when it is missing; production adapters wire it
    // as required (SqliteStorageAdapter).
    provisioning?: ProtocolStorage.ProvisioningSubAdapter;
    sessions?: ProtocolStorage.SessionLedgerSubAdapter;
    actions?: ProtocolStorage.ActionSubAdapter;
    inbox?: ProtocolStorage.InboxSubAdapter;
    alarms?: ProtocolStorage.AlarmSubAdapter;
    policies?: ProtocolStorage.PolicyRowSubAdapter;
  }
}

type StorageScope = {
  adapter: Storage.Adapter | null;
  initializedDbPath: string | null;
};

const storageScope = new AsyncLocalStorage<StorageScope>();

export namespace Storage {
  const requiredProductionCapabilities = [
    "surfaceKey",

    "wait",
    "approval",
    "ledger",
    "egressBudget",
    "actorRegistry",
    "blacklist",
    "channelGrant",
    "replyGrant",
    "provisioning",
    "sessions",
    "actions",
    "inbox",
    "alarms",
    "policies",
  ] as const satisfies readonly (keyof Adapter)[];

  export type ProductionCapability = (typeof requiredProductionCapabilities)[number];

  export function publishObservation<T>(event: BusEvent.Descriptor<T>, data: T): void {
    try {
      Storage.get().observationSink?.publish(event, data);
    } catch {
      // Observations are lossy and cannot alter a committed product result.
    }
  }

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

  export function configure(newAdapter: Adapter): void {
    if (newAdapter[productionStorageAdapterBrand] === true) {
      assertComplete(newAdapter);
    }

    const scope = storageScope.getStore();
    if (scope) {
      scope.adapter = newAdapter;
      scope.initializedDbPath = "__configured__";
      return;
    }
    adapter = newAdapter;
    initializedDbPathValue = "__configured__";
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
