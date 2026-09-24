import { Storage } from "@openomni/ledger";
import { Effect } from "effect";
import { runnerTestLayer } from "./service-layers";
import type { RunnerServices } from "../../src/services";

/** Runs one scoped Effect program against a fresh in-memory ledger; the only test-side runner for agent programs. */
export function isolated<A, E>(program: Effect.Effect<A, E, import("effect").Scope.Scope | RunnerServices>) {
  return Storage.withIsolation(async () => {
    Storage.initialize({ dbPath: ":memory:" });
    try {
      return await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(runnerTestLayer))));
    } finally {
      Storage.reset();
    }
  });
}
