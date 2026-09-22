import { Storage } from "@openomni/ledger";
import { Effect } from "effect";

/** Runs one scoped Effect program against a fresh in-memory ledger; the only test-side runner for agent programs. */
export function isolated<A, E>(program: Effect.Effect<A, E, never>) {
  return Storage.withIsolation(async () => {
    Storage.initialize({ dbPath: ":memory:" });
    try {
      return await Effect.runPromise(program);
    } finally {
      Storage.reset();
    }
  });
}
