import { Effect } from "effect";
import { PlainValueSchema, type Message, type LedgerAction, type PlainValue } from "@openomni/protocol";
import { type ExecutionRequest, ContextRestoreError } from "../../core/api";
import { CompactionRecord, restoreCompactionProjection } from "./durable";

/** The typed compensation of one compaction; a distinct recorded action, never a mutation of the original. */
export function restoreContextRequest(
  compactionId: string,
  predecessorProjectionHash: string,
): ExecutionRequest {
  return {
    kind: "compaction",
    op: "restore_context_projection",
    intent: { compactionId, predecessorProjectionHash },
    effect: {},
    recovery: "local_transactional",
  };
}

/** Validate the caller's target before querying any result children or acquiring a lease. */
export function requireCompactionIntent(
  action: LedgerAction.Node | undefined,
): Effect.Effect<LedgerAction.Node, ContextRestoreError> {
  if (action === undefined || action.kind !== "compaction")
    return Effect.fail(new ContextRestoreError({ reason: "unknown_compaction" }));
  if (field(action.intent.value, "phase") !== "intent")
    return Effect.fail(new ContextRestoreError({ reason: "not_executed" }));
  return Effect.succeed(action);
}

/** The executed child of the already validated original compaction intent. */
export function recordedCompaction(
  compactionId: string,
  result: LedgerAction.Node | undefined,
): Effect.Effect<CompactionRecord, ContextRestoreError> {
  if (
    result?.kind !== "compaction" ||
    result.parentId !== compactionId ||
    field(result.effect.value, "terminal") !== "executed"
  )
    return Effect.fail(new ContextRestoreError({ reason: "not_executed" }));
  return Effect.succeed(CompactionRecord.parse(field(result.effect.value, "result")));
}

/**
 * Rebuild the projection that preceded the compaction from its own recorded
 * recipe applied to the current projection; throws when its kept boundary has
 * since gone or the recipe no longer matches its digest.
 */
export function restoredContextProjection(
  history: readonly Message.WithParts[],
  compactionId: string,
  record: CompactionRecord,
): PlainValue {
  const projection = restoreCompactionProjection(history, record);
  return PlainValueSchema.parse({
    projection,
    restored: { compactionId, discarded: record.discarded },
  });
}

function field(effect: PlainValue, key: "terminal" | "result" | "phase"): PlainValue | undefined {
  return effect !== null && typeof effect === "object" && !Array.isArray(effect)
    ? effect[key]
    : undefined;
}
