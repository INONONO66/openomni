import { WorkItem } from "@openomni/protocol";
import { Storage } from "../storage/storage.js";
import { createWorkItemCompletionWriter } from "./completion-writer.js";
import { WorkItemRevisionError } from "./facts.js";

/**
 * #492 ↔ #490 linkage — projects one effect intent's state onto the WorkItem
 * so completion admission blocks while it is outcome-less. The durable effect
 * audit lives on the `effect:<effectId>` stream (see EffectStore); this is the
 * completion fold's read-model projection: a WorkItem.EffectRecord appended to
 * `completionFacts.effects`. The fold (completion-admission-fold.ts) filters
 * effects to the current attempt and blocks (`effect_outcome_unresolved`) while
 * the latest record per intent is outcome `undefined` or `unknown`.
 *
 * Outcome transitions are APPENDS, not mutations: the adapter's append-only
 * assertion forbids rewriting an existing EffectRecord, so a pending→confirmed
 * transition records a SECOND EffectRecord (same intentRef, later createdAt),
 * and the fold's latest-by-createdAt selection reads the terminal one. The
 * write flows through the authorized completion writer — the same seam the
 * admission service uses — emitting the existing generic `work_item.updated`
 * fact (no new decision-class vocabulary; the effect vocabulary lives on the
 * effect stream).
 */
export type RecordEffectInput = Readonly<{
  intentRef: string;
  outcome?: "unknown" | "confirmed" | "failed";
  id?: string;
}>;

// Bound once: the writer is a closure over Storage.get(), resolved per call
// (AsyncLocalStorage isolation stays honored), and carries the completion
// authority symbol so the append-only completion-fact CAS accepts the write.
const effectWriter = createWorkItemCompletionWriter(() => Storage.get());

export function recordWorkItemEffect(
  hash: string,
  input: RecordEffectInput,
): WorkItem.Info | undefined {
  const adapter = Storage.get().workItem;
  if (!adapter) return undefined;
  const existing = adapter.get(hash);
  if (!existing) return undefined;

  const latest = latestForIntent(existing, input.intentRef);

  // Idempotent replay guard: an auto-id record whose latest state for this
  // intent already matches leaves the append-only log untouched.
  if (input.id === undefined && latest && latest.outcome === input.outcome) return existing;

  // The fold selects the latest EffectRecord per intent by (createdAt, id),
  // so a same-millisecond terminal append must not be shadowed by an earlier
  // pending/unknown record with a larger id — keep createdAt strictly
  // monotonic per intent so the newest write always wins the fold's selection.
  const now =
    latest !== undefined && latest.createdAt >= Date.now() ? latest.createdAt + 1 : Date.now();
  const record = WorkItem.EffectRecord.parse({
    id: input.id ?? crypto.randomUUID(),
    attempt: existing.attempt,
    intentRef: input.intentRef,
    ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
    createdAt: now,
  });
  const next: WorkItem.Info = {
    ...existing,
    revision: existing.revision + 1,
    completionFacts: {
      ...existing.completionFacts,
      revision: existing.completionFacts.revision + 1,
      effects: [...existing.completionFacts.effects, record],
    },
    timestamps: { ...existing.timestamps, updated: now },
  };
  if (!effectWriter(hash, existing.revision, next)) {
    // Stale head: another writer advanced the stream between get and CAS.
    // Nothing was written (the transaction rolled the appended fact back).
    throw new WorkItemRevisionError(hash);
  }
  return next;
}

function latestForIntent(
  item: WorkItem.Info,
  intentRef: string,
): WorkItem.EffectRecord | undefined {
  let latest: WorkItem.EffectRecord | undefined;
  for (const record of item.completionFacts.effects) {
    if (record.intentRef !== intentRef) continue;
    if (!latest || record.createdAt >= latest.createdAt) latest = record;
  }
  return latest;
}
