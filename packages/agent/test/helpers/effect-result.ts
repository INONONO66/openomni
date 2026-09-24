import { Cause, Effect, Exit } from "effect";

function value<A, E>(exit: Exit.Exit<A, E>): A {
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
  return exit.value;
}

export function runFixtureSync<A, E>(effect: Effect.Effect<A, E>): A {
  return value(Effect.runSyncExit(effect));
}

export async function runFixture<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return value(await Effect.runPromiseExit(effect));
}
