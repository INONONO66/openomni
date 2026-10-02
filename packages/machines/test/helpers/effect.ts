import { Effect } from "effect";

export const exit = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.exit(effect));

export const fork = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runFork(effect);
