import { Message, PlainValueSchema, type LedgerAction, type PlainValue } from "@openomni/protocol";
import { z } from "zod";
import type { ExecutionRequest } from "../executor-contract";
import { foldSessionHistory } from "../session-lifecycle/history";
import { type CompactionRecord, restoreCompactionProjection } from "./durable";

const DiscardedRange = z
  .object({
    firstEntryId: z.string(),
    lastEntryId: z.string(),
    count: z.number().int(),
    sha256: z.string(),
  })
  .strict();
const RevertRecipe = z
  .object({ removedEntries: z.array(Message.WithParts), priorAnchorEntryId: z.string().nullable() })
  .strict();
/** The evidence one executed compaction left behind, including its reconstruction recipe. */
const RecordedCompaction: z.ZodType<CompactionRecord> = z.object({
  summary: z.string(),
  firstKeptEntryId: z.string(),
  tokensBefore: z.number(),
  discarded: DiscardedRange,
  revert: RevertRecipe,
});

export class ContextRestoreError extends Error {
  readonly code = "context_restore_refused";
  constructor(readonly reason: "unknown_compaction" | "not_executed") {
    super(`context restore refused: ${reason}`);
    this.name = "ContextRestoreError";
  }
}

/** The typed compensation of one compaction; a distinct recorded action, never a mutation of the original. */
export function restoreContextRequest(compactionId: string): ExecutionRequest {
  return {
    kind: "compaction",
    op: "restore_context_projection",
    intent: { compactionId },
    effect: {},
    recovery: "local_transactional",
  };
}

/** The executed record of `compactionId`; throws when it is unknown or never executed. */
export function recordedCompaction(
  actions: readonly LedgerAction.Node[],
  compactionId: string,
): CompactionRecord {
  const intent = actions.find((action) => action.id === compactionId);
  if (intent === undefined || intent.kind !== "compaction")
    throw new ContextRestoreError("unknown_compaction");
  const result = actions.find(
    (action) =>
      action.kind === "compaction" &&
      action.parentId === compactionId &&
      field(action.effect.value, "terminal") === "executed",
  );
  if (result === undefined) throw new ContextRestoreError("not_executed");
  return RecordedCompaction.parse(field(result.effect.value, "result"));
}

/**
 * Rebuild the projection that preceded the compaction from its own recorded
 * recipe applied to the current projection; throws when its kept boundary has
 * since gone or the recipe no longer matches its digest.
 */
export function restoredContextProjection(
  sessionId: string,
  actions: readonly LedgerAction.Node[],
  compactionId: string,
  record: CompactionRecord,
): PlainValue {
  const projection = restoreCompactionProjection(foldSessionHistory(sessionId, actions), record);
  return PlainValueSchema.parse({
    projection,
    restored: { compactionId, discarded: record.discarded },
  });
}

function field(effect: PlainValue, key: "terminal" | "result"): PlainValue | undefined {
  return effect !== null && typeof effect === "object" && !Array.isArray(effect)
    ? effect[key]
    : undefined;
}
