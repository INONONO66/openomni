import { Effect } from "effect";

/** The only synchronous test-side runner for ledger programs; failures surface as thrown errors. */
export function runLedgerSync<A, E>(program: Effect.Effect<A, E>): A {
  return Effect.runSync(program);
}
