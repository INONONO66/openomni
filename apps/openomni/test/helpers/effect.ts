import { Effect, Either, Exit, Scope } from "effect";

/** Runs an app test Effect at the test boundary. */
export function runEffect<A, E>(effect: Effect.Effect<A, E, never>): Promise<A> {
  return Effect.runPromise(Effect.either(effect)).then((result) =>
    Either.getOrThrowWith(result, (error) => error),
  );
}

/** Synchronous storage setup, preserving the typed failure at the test boundary. */
export function runSyncEffect<A, E>(effect: Effect.Effect<A, E, never>): A {
  return Either.getOrThrowWith(Effect.runSync(Effect.either(effect)), (error) => error);
}

const scopes: Scope.CloseableScope[] = [];
export async function closeAcquiredEffects(): Promise<void> {
  for (const scope of scopes.splice(0).reverse()) {
    await runEffect(Scope.close(scope, Exit.void));
  }
}

/** Acquire a scoped Effect for a fixture; fixture-owned close methods remain authoritative. */
export function acquireEffect<A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> {
  const scope = runSyncEffect(Scope.make());
  scopes.push(scope);
  return runEffect(Scope.extend(effect, scope));
}

export function acquireSyncEffect<A, E>(effect: Effect.Effect<A, E, Scope.Scope>): A {
  const scope = runSyncEffect(Scope.make());
  scopes.push(scope);
  return runSyncEffect(Scope.extend(effect, scope));
}
