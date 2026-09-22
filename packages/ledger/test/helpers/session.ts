import { Effect, Either } from "effect";
import { SessionHandleStore, type LedgerError, type Storage } from "../../src/index";
import type { LedgerSession } from "@openomni/protocol";

export function bareStorageAdapter(): Storage.Adapter {
  return { transaction: <T>(operation: () => T): T => operation() };
}

/** A real configured L0 session for store consumers; no legacy JSON writer. */
export function materializeSession<E = never>(
  id: string,
  parentId: string | null = null,
  afterMaterialize?: (row: LedgerSession.Row) => Effect.Effect<void, E>,
) {
  return Either.getOrThrowWith(
    Effect.runSync(
      Effect.either(
        SessionHandleStore.materialize({
          id,
          parentId,
          role: parentId === null ? "resident" : "worker",
          tools: [],
          system: { preset: "", blocks: [] },
          policyGeneration: 0,
          actionId: `${id}:configure`,
          at: 1,
        }).pipe(Effect.tap((result: LedgerSession.MaterializeResult) =>
          afterMaterialize?.(result.row) ?? Effect.void,
        )),
      ),
    ),
    (error: LedgerError | E) => error,
  ).row;
}
