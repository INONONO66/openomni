import { Effect, Exit, Result, Scope } from "effect";

/** Test edge only: preserve typed failures instead of FiberFailure wrapping them. */
export async function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const result = await Effect.runPromise(Effect.result(effect));
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
}

export function sync<A, E>(effect: Effect.Effect<A, E>): A {
  const result = Effect.runSync(Effect.result(effect));
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
}

export function fork<A, E>(effect: Effect.Effect<A, E>) {
  return Effect.runFork(effect);
}

export function exit<A, E>(effect: Effect.Effect<A, E>) {
  return Effect.runPromiseExit(effect);
}

export async function acquire<A, E>(effect: Effect.Effect<A, E, Scope.Scope>) {
  const scope = Effect.runSync(Scope.make());
  const value = await run(effect.pipe(Effect.provideService(Scope.Scope, scope), Effect.onError(() => Scope.close(scope, Exit.void))));
  return { value, close: () => run(Scope.close(scope, Exit.void)) };
}
