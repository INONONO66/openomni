import { AsyncLocalStorage } from "node:async_hooks";
import type { Storage as ProtocolStorage } from "@openomni/protocol";
import type { Storage } from "../storage/storage.js";

const writerAuthority = Symbol("work-item-completion-writer");
const authorizedWriter = new AsyncLocalStorage<symbol>();

export function createWorkItemCompletionWriter(
  getAdapter: () => ProtocolStorage.WorkItemSubAdapter | undefined,
): Storage.WorkItemCompletionWriter {
  return (hash, expectedHead, item) => {
    const adapter = getAdapter();
    if (!adapter) throw new Error("WorkItem storage is unavailable");
    return authorizedWriter.run(writerAuthority, () =>
      adapter.compareAndSet(hash, expectedHead, item),
    );
  };
}

export function isAuthorizedCompletionWriter(): boolean {
  return authorizedWriter.getStore() === writerAuthority;
}
