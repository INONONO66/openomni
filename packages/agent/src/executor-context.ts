import { AsyncLocalStorage } from "node:async_hooks";
import { Context, Effect, Option } from "effect";
import { GenerationUnavailable, InvocationClosed } from "./errors";
import type { Executor } from "./executor-contract";
import type { CompiledPolicySnapshot } from "@openomni/policy";
import type { Dispatcher } from "./tool-dispatcher";
import type { CapturedGeneration } from "./services";

const invocationLifetime = Symbol("invocationLifetime");
interface InvocationLifetime {
  readonly source: InvocationFrame;
  readonly failure: () => InvocationClosed | GenerationUnavailable | undefined;
}

export interface InvocationFrame {
  readonly [invocationLifetime]?: InvocationLifetime;
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

export function requireOpenInvocation(): InvocationFrame {
  const frame = currentInvocation();
  const failure = frame[invocationLifetime]?.failure();
  if (failure !== undefined) throw failure;
  return frame;
}

/** Transfer a live invocation's captured authority to an independently owned lifetime. */
export function forkInvocation(tool: string) {
  const frame = requireOpenInvocation();
  return openInvocation(frame[invocationLifetime]?.source ?? frame, tool);
}

/** A turn's frame is a template; each admitted body owns a separately revocable view. */
export function openInvocation(frame: InvocationFrame, tool: string) {
  let reason: InvocationClosed["reason"] | undefined;
  const closed = new AbortController();
  const failure = (): InvocationClosed | GenerationUnavailable | undefined => {
    if (reason !== undefined) return new InvocationClosed({ tool, reason });
    if (!frame.generation.isSelected())
      return new GenerationUnavailable({ generation: frame.generation.id.generation });
    return undefined;
  };
  const awaitClose = Effect.async<never, InvocationClosed>((resume) => {
    const notify = () => resume(Effect.fail(new InvocationClosed({ tool, reason: reason ?? "interrupted" })));
    closed.signal.addEventListener("abort", notify, { once: true });
    if (closed.signal.aborted) notify();
    return Effect.sync(() => closed.signal.removeEventListener("abort", notify));
  });
  const guard = <A, E, R>(work: Effect.Effect<A, E, R>) => Effect.suspend<A, E | InvocationClosed | GenerationUnavailable, R>(() => {
    const error = failure();
    return error === undefined ? Effect.raceFirst(frame.generation.provide(work), awaitClose) : Effect.fail(error);
  });
  const { runBatch, runAttempts, recover, judgeStop, approvals } = frame.executor;
  const executor: Executor = {
    run: (request, body) => guard(frame.executor.run(request, body)),
    ...(runBatch === undefined ? {} : {
      runBatch: ((items, control) => guard(runBatch(items, control))) satisfies NonNullable<Executor["runBatch"]>,
    }),
    ...(runAttempts === undefined ? {} : {
      runAttempts: ((parent, attempts) => guard(runAttempts(parent, attempts))) satisfies NonNullable<Executor["runAttempts"]>,
    }),
    ...(recover === undefined ? {} : { recover: () => guard(recover()) }),
    ...(judgeStop === undefined ? {} : {
      judgeStop: ((...args) => guard(judgeStop(...args))) satisfies NonNullable<Executor["judgeStop"]>,
    }),
    ...(approvals === undefined ? {} : { approvals: {
      ...approvals, answer: (answer: Parameters<typeof approvals.answer>[0]) => guard(approvals.answer(answer)),
    } }),
  };
  const cell: Dispatcher = {
    ...frame.cell, executor,
    execute: (call, context) => guard(frame.cell.execute(call, context)),
    executeCell: (call, context) => guard(frame.cell.executeCell(call, context)),
    executeWave: (calls, context) => guard(frame.cell.executeWave(calls, context)),
    recover: (actions, context) => guard(frame.cell.recover(actions, context)),
  };
  return {
    frame: { ...frame, executor, cell, [invocationLifetime]: { source: frame, failure } } satisfies InvocationFrame,
    close: (next: InvocationClosed["reason"]) => {
      if (reason !== undefined) return;
      reason = next;
      closed.abort();
    },
  };
}

export function withInvocation<T>(frame: InvocationFrame, body: () => T): T {
  return activeInvocation.run({ executor: frame.executor, captured: frame }, body);
}
