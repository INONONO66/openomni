import type { Storage as ProtocolStorage, WorkItem } from "@openomni/protocol";

/**
 * #510 C1 — every WorkItem lifecycle write is a decision-class fact on the
 * owner stream `work:<hash>` and awaits its durable append before the
 * projection write (no record, no action). Head↔revision binding mirrors the
 * Wait class (packages/session/src/wait/index.ts):
 *
 *   - fact seq N is the append that produced projected revision N, so
 *     `ledger_head.head` always equals the committed row's `revision`;
 *   - `expectedHead` is the item's revision BEFORE the transition (create
 *     appends work_item.created at expectedHead 0 and projects revision 1);
 *   - append and projection CAS commit inside ONE sync immediate storage
 *     transaction; a projection failure rolls the appended fact back.
 *
 * Pre-cutover rows (migration 0014 backfills them to revision 1 with an
 * empty stream) are adopted lazily: their first post-cutover transition
 * first appends a `work_item.adopted` genesis fact at seq 1 carrying the
 * observed snapshot, keeping expectedHead semantics sound without
 * fabricating history.
 */
export type WorkItemFact = Readonly<{ type: string; data: Record<string, unknown> }>;

export class WorkItemRevisionError extends Error {
  readonly name = "WorkItemRevisionError";
  readonly code = "stale_revision";

  constructor(readonly hash: string) {
    super(`stale WorkItem revision: ${hash}`);
  }
}

export class WorkItemDuplicateError extends Error {
  readonly name = "WorkItemDuplicateError";
  readonly code = "duplicate";

  constructor(readonly hash: string) {
    super(`WorkItem already exists: ${hash}`);
  }
}

function workItemStreamId(hash: string): string {
  return `work:${hash}`;
}

// Durable WorkItem writes fail closed: a missing ledger sub-adapter is an
// error, never warn-and-continue — the projection must not advance without
// its appended fact.
export function requireWorkItemLedger(adapter: {
  ledger?: ProtocolStorage.LedgerSubAdapter;
}): ProtocolStorage.LedgerSubAdapter {
  const ledger = adapter.ledger;
  if (!ledger) {
    throw new Error(
      "Storage adapter does not implement ledger append — durable WorkItem writes fail closed",
    );
  }
  return ledger;
}

/**
 * Appends `work_item.created` at expectedHead 0. A non-empty stream means
 * this work item id was already created — per the #510 C1 ruling, duplicate
 * create maps to the typed duplicate error (ids are kernel-generated and
 * never reused).
 */
export function appendCreatedFact(
  ledger: ProtocolStorage.LedgerSubAdapter,
  item: WorkItem.Info,
  data: Record<string, unknown>,
): void {
  const appended = ledger.append(
    {
      streamId: workItemStreamId(item.hash),
      type: "work_item.created",
      data: { ...data, revision: item.revision },
    },
    0,
  );
  if (appended.kind === "cas_conflict") throw new WorkItemDuplicateError(item.hash);
}

/**
 * Appends one transition fact at expectedHead = the pre-transition revision
 * and injects the resulting revision into the fact data. Returns false on a
 * stale head (nothing written — the transaction can commit as a no-op);
 * MUST run inside the same storage transaction as the projection CAS.
 */
export function appendTransitionFactReceipt(
  ledger: ProtocolStorage.LedgerSubAdapter,
  existing: WorkItem.Info,
  fact: WorkItemFact,
): boolean {
  const event = {
    streamId: workItemStreamId(existing.hash),
    type: fact.type,
    data: { ...fact.data, revision: existing.revision + 1 },
  };
  const appended = ledger.append(event, existing.revision);
  if (appended.kind !== "cas_conflict") return true;
  if (appended.currentHead !== 0 || existing.revision !== 1) return false;
  // Lazy adoption: a backfilled pre-cutover row sits at revision 1 with an
  // empty stream. Its genesis fact records the observed state at seq 1, then
  // the transition fact lands at seq 2 == revision 2.
  const adopted = ledger.append(
    {
      streamId: workItemStreamId(existing.hash),
      type: "work_item.adopted",
      data: { snapshot: existing, revision: existing.revision },
    },
    0,
  );
  if (adopted.kind === "cas_conflict") return false;
  return ledger.append(event, existing.revision).kind !== "cas_conflict";
}

/**
 * #510 C2 — the attempt-allocation fact. The full Attempt identity is the
 * fact payload; `attemptSeq` is allocated by the work stream's serialized
 * append: the projection's `lastAttemptSeq` watermark is bound to the
 * stream head by the same fact-seq == revision equation, so each seq is
 * minted exactly once and never reused.
 */
export function attemptAllocatedFact(
  existing: WorkItem.Info,
  attempt: WorkItem.Attempt,
): WorkItemFact {
  if (attempt.attemptSeq !== existing.lastAttemptSeq + 1) {
    throw new Error(
      `attemptSeq must advance once per serialized append: watermark=${existing.lastAttemptSeq} allocated=${attempt.attemptSeq}`,
    );
  }
  return { type: "work_item.attempt_allocated", data: { ...attempt } };
}

/** Throwing form of {@link appendTransitionFactReceipt} for store writers. */
export function appendTransitionFact(
  ledger: ProtocolStorage.LedgerSubAdapter,
  existing: WorkItem.Info,
  fact: WorkItemFact,
): void {
  if (!appendTransitionFactReceipt(ledger, existing, fact)) {
    throw new WorkItemRevisionError(existing.hash);
  }
}
