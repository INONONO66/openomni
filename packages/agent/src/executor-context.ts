import { AsyncLocalStorage } from "node:async_hooks";
import type { Executor } from "./executor-contract";

export const activeExecutor = new AsyncLocalStorage<Executor>();

export class ExecutorContextError extends Error {
  readonly code = "executor_context_missing";
  constructor() {
    super("executor context is required");
    this.name = "ExecutorContextError";
  }
}

export function currentExecutor(): Executor {
  const executor = activeExecutor.getStore();
  if (executor === undefined) throw new ExecutorContextError();
  return executor;
}
