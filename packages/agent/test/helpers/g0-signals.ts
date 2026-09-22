import { Cause, Chunk, Effect, Exit, Fiber, Option } from "effect";

/** Await an exact external signal or an owned fiber, with timeout only as a failure guard. */
export function awaitSignal<A, E = never, R = never>(
  value: Effect.Effect<A, E, R> | Fiber.Fiber<A, E> | Promise<A>,
): Effect.Effect<A, E, R> {
  if (Fiber.isFiber(value)) return Fiber.join(value);
  if (Effect.isEffect(value)) return value;
  return Effect.promise(() => value);
}

export function failure<A, E, R>(
  program: Effect.Effect<A, E, R>,
): Effect.Effect<unknown, never, R> {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(program);
    if (Exit.isSuccess(exit)) return yield* Effect.die(new Error("Expected a failed Effect"));
    return Option.getOrElse(
      Cause.failureOption(exit.cause),
      () => Chunk.toReadonlyArray(Cause.defects(exit.cause))[0],
    );
  });
}

export function boundedSignal<A, E = never, R = never>(
  value: Effect.Effect<A, E, R> | Fiber.Fiber<A, E> | Promise<A>,
  label: string,
) {
  return awaitSignal(value).pipe(
    Effect.timeoutFail({ duration: 1000, onTimeout: () => new Error(`Timed out: ${label}`) }),
  );
}
