import { Cause, Effect, Queue } from "effect";
import type { IpcError } from "./errors";

/** The acquiring app scope owns every callback task; socket callbacks never run a runtime. */
export const makeDispatcher = Effect.gen(function* () {
  const queue = yield* Queue.unbounded<Effect.Effect<void, IpcError>>();
  yield* Effect.forkScoped(Effect.forever(Effect.gen(function* () {
    const task = yield* Queue.take(queue);
    yield* Effect.forkScoped(task.pipe(Effect.catchAllCause((cause) => Effect.logError(Cause.pretty(cause)))));
  })));
  yield* Effect.addFinalizer(() => Queue.shutdown(queue));
  return (task: Effect.Effect<void, IpcError>): void => { queue.unsafeOffer(task); };
});
