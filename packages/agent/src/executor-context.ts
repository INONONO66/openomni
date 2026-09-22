import { AsyncLocalStorage } from "node:async_hooks";
import { Context, Effect, Option } from "effect";
import type { Executor } from "./executor-contract";

export const activeExecutor = new AsyncLocalStorage<Executor>();
export class ExecutorContext extends Context.Tag("@openomni/agent/ExecutorContext")<ExecutorContext, Executor>() {}

export const executorContext = Effect.serviceOption(ExecutorContext).pipe(
  Effect.map((native) => Option.getOrElse(native, currentExecutor)),
);

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

/** Re-enter only executor authority; callers must not carry unrelated ALS scopes across RPC. */
export function withExecutor<T>(executor: Executor, body: () => T): T {
  return activeExecutor.run(executor, body);
}
