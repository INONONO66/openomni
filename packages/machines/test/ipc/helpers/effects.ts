import { Effect, Result, Exit, Scope } from "effect";

/** Test edge only: preserve the typed failure rather than FiberFailure wrapping it. */
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
export async function acquire<A, E>(effect: Effect.Effect<A, E, Scope.Scope>) {
  const scope = Effect.runSync(Scope.make());
  const value = await run(effect.pipe(Effect.provideService(Scope.Scope, scope), Effect.onError(() => Scope.close(scope, Exit.void))));
  return { value, close: () => run(Scope.close(scope, Exit.void)) };
}
export function acquireSync<A, E>(effect: Effect.Effect<A, E, Scope.Scope>) {
  const scope = Effect.runSync(Scope.make());
  const value = sync(effect.pipe(Effect.provideService(Scope.Scope, scope)));
  return { value, close: () => run(Scope.close(scope, Exit.void)) };
}
