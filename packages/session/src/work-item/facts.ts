import { LedgerAppend, type Storage as ProtocolStorage, type WorkItem } from "@openomni/protocol";
import { isSqliteBusyError } from "../storage/sqlite-busy.js";

/**
 * #510 C1 — every WorkItem lifecycle write is a decision-class fact on the
 * owner stream `work:<workItemId>` and awaits its durable append before the
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
 * Pre-cutover rows (migration 0014 shifts them to old json revision + 1, so
 * any revision >= 1 with an EMPTY stream) are adopted lazily: their first
 * post-cutover transition adopts the stream at the observed revision via
 * `Ledger.adoptStream` — a `work_item.adopted` genesis fact carrying the
 * observed snapshot at seq === revision — keeping expectedHead semantics
 * sound without fabricating per-transition history (#510 review fix F4).
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

export class WorkItemUnavailableError extends Error {
  readonly name = "WorkItemUnavailableError";
  readonly code = "unavailable";

  constructor(
    readonly hash: string,
    cause: unknown,
  ) {
    super(
      `WorkItem storage busy: ${hash} — ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/**
 * Store transaction entry (#510 review fix minor): a SQLITE_BUSY at the
 * write unit (see storage/sqlite-busy.ts for how bun:sqlite surfaces it)
 * means nothing committed — mapped to the typed `unavailable` error so
 * callers branch on the taxonomy, never on driver message text. Every other
 * error passes through unchanged.
 */
export function runWorkItemTransaction<T>(
  storage: { transaction<R>(operation: () => R): R },
  hash: string,
  write: () => T,
): T {
  try {
    return storage.transaction(write);
  } catch (error) {
    if (isSqliteBusyError(error)) throw new WorkItemUnavailableError(hash, error);
    throw error;
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
      streamId: workItemStreamId(item.workItemId),
      type: "work_item.created",
      data: { ...data, revision: item.revision },
    },
    0,
  );
  if (appended.kind === "cas_conflict") throw new WorkItemDuplicateError(item.workItemId);
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
    streamId: workItemStreamId(existing.workItemId),
    type: fact.type,
    data: { ...fact.data, revision: existing.revision + 1 },
  };
  const appended = ledger.append(event, existing.revision);
  if (appended.kind !== "cas_conflict") return true;
  if (appended.currentHead !== 0 || existing.revision < 1) return false;
  // Lazy adoption: a pre-cutover row sits at revision >= 1 (0014 shifts old
  // json revisions by +1) with an empty stream. Adopt the stream at the
  // observed revision — the genesis fact records the observed state at
  // seq === revision — then the transition fact lands at revision + 1. A
  // concurrent adopter loses as the same stale-head receipt (false).
  try {
    // Recorded divergence (#606): this adopted genesis bakes the FULL
    // WorkItem.Info snapshot (including user content) into the immutable
    // hash-chained ledger, while the wait family (wait/index.ts wait.adopted)
    // deliberately carries identity fields only, for erasability. Persisted
    // fact shapes are ledger baselines; converging them is an Owner decision.
    ledger.adoptStream(workItemStreamId(existing.workItemId), existing.revision, {
      type: "work_item.adopted",
      data: { snapshot: existing, revision: existing.revision },
    });
  } catch (error) {
    if (LedgerAppend.AdoptError.isInstance(error)) return false;
    throw error;
  }
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
    throw new WorkItemRevisionError(existing.workItemId);
  }
}
