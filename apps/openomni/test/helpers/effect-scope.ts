import { Effect, Exit, Scope } from "effect";
import { runEffect, runSyncEffect } from "./effect";

/** A resource scope kept alive across imperative test actions. */
export function effectScope() {
  const scope = Effect.runSync(Scope.make());
  return {
    runSync<A, E>(effect: Effect.Effect<A, E, Scope.Scope>): A {
      return runSyncEffect(Scope.extend(effect, scope));
    },
    run<A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> {
      return runEffect(Scope.extend(effect, scope));
    },
    close: () => runEffect(Scope.close(scope, Exit.void)),
  };
}
