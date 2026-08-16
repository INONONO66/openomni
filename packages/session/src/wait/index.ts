import { LedgerAppend, Wait, type Storage as ProtocolStorage } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { isSqliteBusyError } from "../storage/sqlite-busy";
import { Storage } from "../storage/storage";
import { withCreateTimestamps } from "../storage/timestamped-store";

// Durable Wait writes fail closed (#215 owner decision 1): a missing wait
// sub-adapter is a typed error, never warn-and-return. Deliberately NOT
// requireSubAdapter — that helper throws an untyped Error.
function requireAdapter(): ProtocolStorage.WaitSubAdapter {
  const adapter = Storage.get().wait;
  if (!adapter) {
    throw new Wait.StoreError({
      message: "Storage adapter does not implement wait — durable Wait writes fail closed",
      code: "adapter_absent",
    });
  }
  return adapter;
}

/**
 * #510 phase B — every Wait state change is a decision-class fact on the
 * owner stream `wait:<waitId>` and awaits its durable append before the
 * projection write (no record, no action). Head↔revision binding:
 *
 *   - fact seq N is the append that produced projected revision N, so
 *     `ledger_head.head` always equals the committed record's `revision`;
 *   - `expectedHead` is therefore the wait's revision BEFORE the transition
 *     (create appends wait.opened at expectedHead 0 and projects revision 1);
 *   - append and projection CAS commit inside ONE sync immediate storage
 *     transaction; a projection CAS failure rolls the appended fact back, so
 *     the CAS receipt and the ledger head can never disagree;
 *   - a PRE-CUTOVER row (revision >= 1, empty owner stream — its writes
 *     predate phase B) is adopted lazily on its first transition: a
 *     wait.adopted genesis fact (owner/status/expiry identity only — never
 *     the erasable record snapshot) lands at seq === revision via
 *     Ledger.adoptStream, then the transition proceeds (#510 review fix F3).
 */
function requireLedger(): ProtocolStorage.LedgerSubAdapter {
  const ledger = Storage.get().ledger;
  if (!ledger) {
    throw new Wait.StoreError({
      message: "Storage adapter does not implement ledger append — durable Wait writes fail closed",
      code: "adapter_absent",
    });
  }
  return ledger;
}

function waitStreamId(waitId: string): string {
  return `wait:${waitId}`;
}

function revisionConflict(waitId: string, expected: number): InstanceType<typeof Wait.StoreError> {
  return new Wait.StoreError({
    message: `Wait revision conflict: ${waitId} expected=${expected}`,
    code: "revision_conflict",
    waitId,
  });
}

/**
 * Store transaction entry (#510 review fix minor): a SQLITE_BUSY at the
 * write unit (see storage/sqlite-busy.ts for how bun:sqlite surfaces it)
 * means nothing committed — mapped to the typed `unavailable` store error so
 * callers branch on the taxonomy, never on driver message text. Every other
 * error passes through unchanged.
 */
function runWaitTransaction<T>(waitId: string, write: () => T): T {
  try {
    return Storage.get().transaction(write);
  } catch (error) {
    if (isSqliteBusyError(error)) {
      throw new Wait.StoreError({
        message: `Wait storage busy: ${waitId} — ${error instanceof Error ? error.message : String(error)}`,
        code: "unavailable",
        waitId,
      });
    }
    throw error;
  }
}

type CommittedOutcome = Exclude<Wait.Outcome, { kind: "rejected" } | { kind: "already_resolved" }>;

/**
 * Decision-class fact for one committed fold outcome: the outcome's typed
 * fields plus the resulting revision — never the record snapshot (the wait
 * projection row remains the read model). `timeCreated` is deliberately
 * absent: the append core writer-assigns it at the append site.
 */
function factOf(outcome: CommittedOutcome): { type: string; data: Record<string, unknown> } {
  const revision = outcome.record.revision;
  switch (outcome.kind) {
    case "attached":
      return {
        type: "wait.attached",
        data: {
          replyKey: outcome.reply.replyKey,
          responderId: outcome.reply.responderId,
          responders: outcome.responders,
          threshold: outcome.threshold,
          followUp: outcome.followUp,
          revision,
        },
      };
    case "resolved":
      return {
        type: "wait.resolved",
        data: {
          replyKey: outcome.reply.replyKey,
          responderId: outcome.reply.responderId,
          responders: outcome.responders,
          threshold: outcome.threshold,
          resolvedAt: outcome.record.resolvedAt ?? outcome.record.updatedAt,
          revision,
        },
      };
    case "expired":
      return { type: "wait.expired", data: { partial: outcome.partial, revision } };
    case "cancelled":
      return {
        type: "wait.cancelled",
        data: { cancelledAt: outcome.record.cancelledAt ?? outcome.record.updatedAt, revision },
      };
    case "delivery_recorded":
      return {
        type: "wait.delivery_recorded",
        data: { externalMessageId: outcome.externalMessageId, revision },
      };
  }
}

function eventBase(record: Wait.Record, time: number, traceId: string) {
  return {
    id: record.id,
    traceId,
    ownerKind: record.ownerRef.kind,
    ownerId: record.ownerRef.id,
    status: record.status,
    time,
  };
}

function stillCorrelatable(record: Wait.Record, now: number): boolean {
  // Open rows surface even past their deadline: pre-filtering expired-open
  // waits here would silently drop late replies into surface routing. The
  // deadline rule is owned by the fold (deadline_passed) plus the kernel's
  // lazy expiry; only resolved rows age out of correlation here (follow-up
  // window), because a resolved wait has already been delivered.
  if (record.status === "open") return true;
  if (record.status === "resolved" && record.resolvedAt !== undefined) {
    return now <= record.resolvedAt + record.followUpWindow;
  }
  return false;
}

// Bus stays observe-only for the wait decision class (#510): these publishes
// are lossy projections of the appended facts and fire only AFTER the
// append+projection transaction committed — a subscriber can never write the
// ledger or authorize an action from them.
function publishChange(outcome: CommittedOutcome, traceId: string): void {
  const base = eventBase(outcome.record, outcome.record.updatedAt, traceId);
  switch (outcome.kind) {
    case "attached":
      Bus.publish(Wait.Events.ReplyAttached, {
        ...base,
        replyKey: outcome.reply.replyKey,
        responderId: outcome.reply.responderId,
        responders: outcome.responders,
        threshold: outcome.threshold,
        followUp: outcome.followUp,
      });
      return;
    case "resolved":
      Bus.publish(Wait.Events.ReplyAttached, {
        ...base,
        replyKey: outcome.reply.replyKey,
        responderId: outcome.reply.responderId,
        responders: outcome.responders,
        threshold: outcome.threshold,
        followUp: false,
      });
      Bus.publish(Wait.Events.Resolved, { ...base, resolvedAt: outcome.record.updatedAt });
      return;
    case "expired":
      Bus.publish(Wait.Events.Expired, { ...base, partial: outcome.partial });
      return;
    case "cancelled":
      Bus.publish(Wait.Events.Cancelled, { ...base, cancelledAt: outcome.record.updatedAt });
      return;
    case "delivery_recorded":
      // Correlation projection update only (replyToMessageId re-keys to the
      // platform message id). The durable wait.delivery_recorded fact lives
      // on the owner stream; the delivery itself is already audited by the
      // messaging Sent event — no separate wait.* Bus event.
      return;
  }
}

export namespace WaitStore {
  export type Record = Wait.Record;

  export function create(input: Wait.Create, traceId: string): Wait.Record {
    const adapter = requireAdapter();
    const ledger = requireLedger();
    // Single write-shape owner: this Record.parse is the factory that
    // enforces resolution-policy coherence (see Wait.Create doc). Revision
    // starts at 1 — the wait.opened fact is seq 1 on the owner stream, so
    // head === revision from birth (see the binding note at requireLedger).
    const record = Wait.Record.parse(
      withCreateTimestamps({
        ...input,
        status: "open",
        partial: false,
        replies: [],
        revision: 1,
      }),
    );
    const duplicate = () =>
      new Wait.StoreError({
        message: `Wait already exists for id ${record.id} or originMessageId ${record.originMessageId}`,
        code: "duplicate",
        waitId: record.id,
      });
    runWaitTransaction(record.id, () => {
      const appended = ledger.append(
        {
          streamId: waitStreamId(record.id),
          type: "wait.opened",
          data: {
            ownerKind: record.ownerRef.kind,
            ownerId: record.ownerRef.id,
            originMessageId: record.originMessageId,
            expiresAt: record.expiresAt,
            revision: record.revision,
          },
        },
        0,
      );
      // A non-empty stream means this wait id was already opened; a failed
      // INSERT receipt (duplicate id or originMessageId) aborts the
      // transaction, rolling the appended fact back with it.
      if (appended.kind === "cas_conflict") throw duplicate();
      if (!adapter.create(record)) throw duplicate();
    });
    Bus.publish(Wait.Events.Opened, eventBase(record, record.createdAt, traceId));
    return record;
  }

  export function get(id: string): Wait.Record | undefined {
    return requireAdapter().get(id);
  }

  export function list(status?: Wait.Status[]): Wait.Record[] {
    return requireAdapter().list(status);
  }

  export function findByCorrelation(query: Wait.CorrelationQuery, now = Date.now()): Wait.Record[] {
    return requireAdapter()
      .findByCorrelation(Wait.CorrelationQuery.parse(query))
      .filter((record) => stillCorrelatable(record, now));
  }

  /**
   * Persists one fold outcome: the decision-class fact appends to the
   * `wait:<id>` stream FIRST, then the projection lands under a revision
   * compare-and-set — both inside one sync immediate storage transaction
   * (no record, no action). Rejected outcomes write nothing; a stale head
   * (ledger cas_conflict) and a failed projection CAS both surface as the
   * same typed revision_conflict, and the transaction rollback keeps the
   * ledger head equal to the projected revision either way. Retrying from
   * the fresh head is the caller's decision.
   */
  export function transition(
    id: string,
    step: (record: Wait.Record) => Wait.Outcome,
    traceId: string,
  ): Wait.Outcome {
    const adapter = requireAdapter();
    const ledger = requireLedger();
    const current = adapter.get(id);
    if (!current) {
      throw new Wait.StoreError({
        message: `Wait not found: ${id}`,
        code: "not_found",
        waitId: id,
      });
    }
    const outcome = step(current);
    // No-write outcomes: rejections never persist; already_resolved returns
    // the recorded resolution unchanged (redelivery short-circuit — no state
    // change, no revision bump, no event).
    if (outcome.kind === "rejected" || outcome.kind === "already_resolved") return outcome;
    const fact = factOf(outcome);
    runWaitTransaction(id, () => {
      const event = { streamId: waitStreamId(id), type: fact.type, data: fact.data };
      let appended = ledger.append(event, current.revision);
      if (appended.kind === "cas_conflict" && appended.currentHead === 0 && current.revision >= 1) {
        // Lazy adoption (#510 review fix F3): a pre-cutover wait row exists
        // at revision >= 1 with an EMPTY owner stream (its writes predate the
        // phase-B cutover). Adopt the stream at the observed revision — the
        // wait.adopted genesis lands at seq === revision — then retry the
        // transition append at the same head. A concurrent adopter throws
        // the typed AdoptError, which surfaces as the same revision_conflict
        // any lost race produces. The genesis payload mirrors wait.opened
        // and deliberately carries NO erasable data: the hash-chained ledger
        // is immutable, so replies (responder ids), correlation identifiers,
        // and allowed-action/identity fields must never be baked into it —
        // the projection row remains the read model for those.
        try {
          ledger.adoptStream(waitStreamId(id), current.revision, {
            type: "wait.adopted",
            data: {
              ownerKind: current.ownerRef.kind,
              ownerId: current.ownerRef.id,
              status: current.status,
              expiresAt: current.expiresAt,
              revision: current.revision,
            },
          });
        } catch (error) {
          if (LedgerAppend.AdoptError.isInstance(error)) {
            throw revisionConflict(id, current.revision);
          }
          throw error;
        }
        appended = ledger.append(event, current.revision);
      }
      if (appended.kind === "cas_conflict") throw revisionConflict(id, current.revision);
      if (!adapter.compareAndSet(id, current.revision, outcome.record)) {
        // Unreachable while every writer goes through this transaction (the
        // append CAS and the projection CAS guard the same head==revision);
        // kept as the explosive backstop — the rollback discards the
        // appended fact so head and revision still agree.
        throw revisionConflict(id, current.revision);
      }
    });
    publishChange(outcome, traceId);
    return outcome;
  }

  export function attachReply(id: string, input: Wait.ReplyInput, traceId: string): Wait.Outcome {
    const parsed = Wait.ReplyInput.parse(input);
    const outcome = transition(id, (record) => Wait.attachReply(record, parsed), traceId);
    if (outcome.kind === "rejected") {
      Bus.publish(Wait.Events.ReplyRejected, {
        ...eventBase(outcome.record, outcome.at, traceId),
        code: outcome.code,
        replyKey: parsed.replyKey,
      });
    }
    return outcome;
  }

  /**
   * Records the platform message id of the awaited outbound delivery on an
   * open wait (fold recordDeliveryReceipt): correlation.replyToMessageId
   * re-keys to the platform id under the same revision CAS as every other
   * transition.
   */
  export function recordDeliveryReceipt(
    id: string,
    input: Wait.DeliveryReceiptInput,
    traceId: string,
  ): Wait.Outcome {
    const parsed = Wait.DeliveryReceiptInput.parse(input);
    return transition(id, (record) => Wait.recordDeliveryReceipt(record, parsed), traceId);
  }

  export function expire(id: string, traceId: string, at = Date.now()): Wait.Outcome {
    return transition(id, (record) => Wait.expire(record, { at }), traceId);
  }

  export function cancel(id: string, traceId: string, at = Date.now()): Wait.Outcome {
    return transition(id, (record) => Wait.cancel(record, { at }), traceId);
  }
}
