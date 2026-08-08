import type { Message, Storage as ProtocolStorage, WorkItem } from "@openomni/protocol";
import { AsyncLocalStorage } from "node:async_hooks";
import { createWorkItemCompletionWriter } from "../work-item/completion-writer.js";
import type { SessionInfo } from "../session/info";
import type { WorkerRunStateStore } from "../worker-run/state-store";
import { SqliteStorageAdapter } from "./sqlite-storage";

// Same-process application modules are trusted composition-root code. The completion writer
// prevents accidental bypass through ordinary store APIs; it is not an OS isolation boundary.
export namespace Storage {
  export type WorkItemCompletionWriter = (
    hash: string,
    expectedHead: number,
    item: WorkItem.Info,
  ) => boolean;

  export type MessagePage = {
    items: Message.Info[];
    nextCursor: string | null;
    more: boolean;
  };

  export interface Adapter {
    transaction<T>(operation: () => T): T;
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
      listPage?(sessionID: string, options: { limit: number; before?: string }): MessagePage;
      remove(sessionID: string, messageID: string): boolean;
      setStatus?(messageID: string, status: string): void;
      findByStatus?(status: string): Array<{ id: string; sessionId: string }>;
    };
    part: {
      get(messageID: string, partID: string): Message.Part | undefined;
      set(messageID: string, part: Message.Part): void;
      list(messageID: string): Message.Part[];
      listByMessageIDs?(messageIDs: string[]): Message.Part[];
      remove(messageID: string, partID: string): boolean;
    };

    surfaceKey?: {
      register(key: string, sessionId: string): void;
      claim(key: string, sessionId: string, expectedSessionId?: string): string;
      lookup(key: string): string | undefined;
      delete(key: string): void;
      listBySession?(sessionId: string): string[];
    };
    artifact?: {
      store(id: string, sessionId: string, meta: string, content: string): void;
      get(id: string): { meta: string; content: string; sessionId: string } | undefined;
      list(sessionId: string): Array<{ id: string; meta: string; content: string }>;
      delete(id: string): void;
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
  warnedOnce: boolean;
};

const storageScope = new AsyncLocalStorage<StorageScope>();

export namespace Storage {
  let adapter: Adapter | null = null;
  let initializedDbPathValue: string | null = null;
  let warnedOnce = false;

  export function configure(newAdapter: Adapter): WorkItemCompletionWriter {
    const scope = storageScope.getStore();
    if (scope) {
      scope.adapter = newAdapter;
      scope.initializedDbPath = "__configured__";
      return createWorkItemCompletionWriter(() => Storage.get().workItem);
    }
    adapter = newAdapter;
    initializedDbPathValue = "__configured__";
    return createWorkItemCompletionWriter(() => Storage.get().workItem);
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

  export function get(): Adapter {
    const scope = storageScope.getStore();
    if (scope) {
      if (scope.adapter === null) {
        if (!scope.warnedOnce) {
          console.warn(
            "Storage.get() called before initialize() — auto-initializing in-memory adapter. Call Storage.initialize({ dbPath }) at app entry to suppress this warning.",
          );
          scope.warnedOnce = true;
        }
        scope.adapter = new SqliteStorageAdapter(":memory:");
      }
      return scope.adapter;
    }
    if (adapter === null) {
      if (!warnedOnce) {
        console.warn(
          "Storage.get() called before initialize() — auto-initializing in-memory adapter. Call Storage.initialize({ dbPath }) at app entry to suppress this warning.",
        );
        warnedOnce = true;
      }
      adapter = new SqliteStorageAdapter(":memory:");
    }
    return adapter;
  }

  export function getAdapter(): Adapter {
    return get();
  }

  export function reset(): void {
    const scope = storageScope.getStore();
    if (scope) {
      scope.adapter = null;
      scope.initializedDbPath = null;
      scope.warnedOnce = false;
      return;
    }
    adapter = null;
    initializedDbPathValue = null;
    warnedOnce = false;
  }

  export function withIsolation<T>(operation: () => T): T {
    return storageScope.run(
      { adapter: null, initializedDbPath: null, warnedOnce: false },
      operation,
    );
  }
}
