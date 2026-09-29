import { Effect, Result, Exit, Scope } from "effect";
import type { AppRuntime, AppServices } from "../../src/runtime";

/** Runs an app test Effect at the test boundary. */
export function runEffect<A, E>(effect: Effect.Effect<A, E, never>): Promise<A> {
  return Effect.runPromise(Effect.result(effect)).then((result) =>
    Result.getOrThrowWith(result, (error) => error),
  );
}

/** Synchronous storage setup, preserving the typed failure at the test boundary. */
export function runSyncEffect<A, E>(effect: Effect.Effect<A, E, never>): A {
  return Result.getOrThrowWith(Effect.runSync(Effect.result(effect)), (error) => error);
}

/** Execute through the app runtime so its injected services remain available. */
export function runRuntimeEffect<A, E, R extends AppServices>(
  runtime: AppRuntime,
  effect: Effect.Effect<A, E, R>,
): Promise<A> {
  return runtime.runPromise(effect);
}

/** Preserve an Exit when an app runtime disposal is the behavior under test. */
export function runRuntimeExit<A, E, R extends AppServices>(
  runtime: AppRuntime,
  effect: Effect.Effect<A, E, R>,
): Promise<Exit.Exit<A, E>> {
  return runtime.runPromise(Effect.exit(effect));
}

export function runSyncResult<A, E>(effect: Effect.Effect<A, E, never>): Result.Result<A, E> {
  return Effect.runSync(Effect.result(effect));
}

const scopes: Scope.Closeable[] = [];
export async function closeAcquiredEffects(): Promise<void> {
  for (const scope of scopes.splice(0).reverse()) {
    await runEffect(Scope.close(scope, Exit.void));
  }
}

/** Acquire a scoped Effect for a fixture; fixture-owned close methods remain authoritative. */
export function acquireEffect<A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> {
  const scope = runSyncEffect(Scope.make());
  scopes.push(scope);
  return runEffect(Scope.provide(effect, scope));
}

export function acquireSyncEffect<A, E>(effect: Effect.Effect<A, E, Scope.Scope>): A {
  const scope = runSyncEffect(Scope.make());
  scopes.push(scope);
  return runSyncEffect(Scope.provide(effect, scope));
}
