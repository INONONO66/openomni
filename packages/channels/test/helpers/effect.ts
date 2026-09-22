import { Effect } from "effect";

/** Runs a channel Effect in tests; all test-side Effect execution is centralized here. */
export function runEffect<A, E>(program: Effect.Effect<A, E, never>): Promise<A>;
export function runEffect<A, E>(program: Effect.Effect<A, E, never>, mode: "sync"): A;
export function runEffect<A, E>(program: Effect.Effect<A, E, never>, mode?: "sync"): A | Promise<A> {
  return mode === "sync" ? Effect.runSync(program) : Effect.runPromise(program);
}
