import { Cause, Effect, Queue, Semaphore, type Scope } from "effect";
import { IpcQueueFullError, type IpcError } from "./errors";

/**
 * Offers a task; a full queue answers with the typed error instead of
 * dropping the task silently. The call site decides how to surface it.
 */
export type Dispatch = (task: Effect.Effect<void, IpcError>) => IpcQueueFullError | undefined;

/** The acquiring app scope owns every callback task; socket callbacks never run a runtime. */
/**
 * Bounded callback dispatcher (#1312): `bound` caps BOTH the queue depth and
 * the executor fan-out. Required, no default — the acquiring app composition
 * chooses the value (injection law).
 */
export function makeDispatcher(options: { readonly bound: number }): Effect.Effect<Dispatch, never, Scope.Scope> {
  return Effect.gen(function* () {
    const queue = yield* Queue.bounded<Effect.Effect<void, IpcError>>(options.bound);
    // Bounded fan-out: at most `bound` tasks run at once; the (bounded) queue
    // absorbs the rest. Tasks keep their own fibers so one that closes the
    // owning scope (e.g. a transport-loss handler) never deadlocks the pump.
    const permits = yield* Semaphore.make(options.bound);
    yield* Effect.forkScoped(Effect.forever(Effect.gen(function* () {
      const task = yield* Queue.take(queue);
      yield* Semaphore.take(permits, 1);
      yield* Effect.forkScoped(task.pipe(Effect.catchCause((cause) => Effect.logError(Cause.pretty(cause))), Effect.ensuring(Semaphore.release(permits, 1))));
    })));
    yield* Effect.addFinalizer(() => Queue.shutdown(queue));
    return (task: Effect.Effect<void, IpcError>): IpcQueueFullError | undefined => {
      if (Queue.offerUnsafe(queue, task)) return undefined;
      // A queue that is tearing down with its owning scope refuses offers too;
      // that is orderly shutdown, not backpressure — only a LIVE full queue
      // answers with the typed error (#1312).
      return queue.state._tag === "Open" ? new IpcQueueFullError({ message: `IPC dispatcher queue is full (bound ${options.bound})`, bound: options.bound }) : undefined;
    };
  });
}
