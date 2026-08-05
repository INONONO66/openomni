import { AsyncLocalStorage } from "node:async_hooks";

const completionWriter = new AsyncLocalStorage<true>();

export function withWorkItemCompletionWriter<T>(operation: () => T): T {
  return completionWriter.run(true, operation);
}

export function isWorkItemCompletionWriter(): boolean {
  return completionWriter.getStore() === true;
}
