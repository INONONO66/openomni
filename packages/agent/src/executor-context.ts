import { AsyncLocalStorage } from "node:async_hooks";
import { Context, Effect, Option } from "effect";
import type { Executor } from "./executor-contract";
import type { CompiledPolicySnapshot } from "@openomni/policy";
import type { Dispatcher } from "./tool-dispatcher";
import type { CapturedGeneration } from "./services";

export interface InvocationFrame {
  readonly executor: Executor;
  readonly cell: Dispatcher;
  readonly policy: CompiledPolicySnapshot;
  readonly generation: CapturedGeneration;
}
export const activeInvocation = new AsyncLocalStorage<{ readonly executor: Executor; readonly captured?: InvocationFrame }>();
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
  const executor = activeInvocation.getStore()?.executor;
  if (executor === undefined) throw new ExecutorContextError();
  return executor;
}

/** Re-enter only executor authority; callers must not carry unrelated ALS scopes across RPC. */
export function withExecutor<T>(executor: Executor, body: () => T): T {
  const frame = activeInvocation.getStore();
  return activeInvocation.run(frame?.executor === executor ? frame : { executor }, body);
}

export function currentInvocation(): InvocationFrame {
  const frame = activeInvocation.getStore()?.captured;
  if (frame === undefined) throw new ExecutorContextError();
  return frame;
}

export function withInvocation<T>(frame: InvocationFrame, body: () => T): T {
  return activeInvocation.run({ executor: frame.executor, captured: frame }, body);
}
