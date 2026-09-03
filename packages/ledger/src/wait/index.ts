import { Wait, type Storage as ProtocolStorage } from "@openomni/protocol";
import { Bus as LegacyObservationSink } from "@openomni/telemetry";
import { commitFact, runCommitTransaction } from "../storage/commit-coordinator";
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
 * Store transaction entry (#510 review fix minor): the shared commit
 * coordinator owns the transaction and the SQLITE_BUSY detection; this store
 * supplies only the Wait TAXONOMY for "nothing committed", so callers branch
 * on `data.code` and never on driver message text.
 */
function runWaitTransaction<T>(waitId: string, write: () => T): T {
  return runCommitTransaction(
    Storage.get(),
    write,
    (cause) =>
      new Wait.StoreError({
        message: `Wait storage busy: ${waitId} — ${cause instanceof Error ? cause.message : String(cause)}`,
        code: "unavailable",
        waitId,
      }),
  );
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

// Bus stays observe-only for the wait decision class (#510): these publishes
// are lossy projections of the appended facts and fire only AFTER the
// append+projection transaction committed — a subscriber can never write the
// ledger or authorize an action from them.
function publishChange(outcome: CommittedOutcome, traceId: string): void {
  const base = eventBase(outcome.record, outcome.record.updatedAt, traceId);
  switch (outcome.kind) {
    case "attached":
      LegacyObservationSink.publish(Wait.Events.ReplyAttached, {
        ...base,
        replyKey: outcome.reply.replyKey,
        responderId: outcome.reply.responderId,
        responders: outcome.responders,
        threshold: outcome.threshold,
        followUp: outcome.followUp,
      });
      return;
    case "resolved":
      LegacyObservationSink.publish(Wait.Events.ReplyAttached, {
        ...base,
        replyKey: outcome.reply.replyKey,
        responderId: outcome.reply.responderId,
        responders: outcome.responders,
        threshold: outcome.threshold,
        followUp: false,
      });
      LegacyObservationSink.publish(Wait.Events.Resolved, { ...base, resolvedAt: outcome.record.updatedAt });
      return;
    case "expired":
      LegacyObservationSink.publish(Wait.Events.Expired, { ...base, partial: outcome.partial });
      return;
    case "cancelled":
      LegacyObservationSink.publish(Wait.Events.Cancelled, { ...base, cancelledAt: outcome.record.updatedAt });
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
      // A non-empty stream means this wait id was already opened; a failed
      // INSERT receipt (duplicate id or originMessageId) refuses the commit,
      // rolling the appended fact back with the transaction. Birth has no
      // adoption path — expectedHead 0 IS the empty-stream expectation.
      const outcome = commitFact(
        ledger,
        {
          streamId: waitStreamId(record.id),
          expectedHead: 0,
          fact: {
            type: "wait.opened",
            data: {
              ownerKind: record.ownerRef.kind,
              ownerId: record.ownerRef.id,
              originMessageId: record.originMessageId,
              expiresAt: record.expiresAt,
              revision: record.revision,
            },
          },
        },
        () => adapter.create(record) || false,
      );
      if (outcome.kind !== "committed") throw duplicate();
    });
    LegacyObservationSink.publish(Wait.Events.Opened, eventBase(record, record.createdAt, traceId));
    return record;
  }

  export function get(id: string): Wait.Record | undefined {
    return requireAdapter().get(id);
  }

  export function list(status?: Wait.Status[]): Wait.Record[] {
    return requireAdapter().list(status);
  }

  /** Raw indexed facts; channels owns correlation visibility and precedence. */
  export function findByCorrelation(query: Wait.CorrelationQuery): Wait.Record[] {
    return requireAdapter().findByCorrelation(Wait.CorrelationQuery.parse(query));
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
  export function commit(
    outcome: Wait.Outcome,
    traceId: string,
    rejectionReplyKey?: string,
  ): Wait.Outcome {
    const adapter = requireAdapter();
    const ledger = requireLedger();
    const id = outcome.record.id;
    const current = adapter.get(id);
    if (!current) {
      throw new Wait.StoreError({
        message: `Wait not found: ${id}`,
        code: "not_found",
        waitId: id,
      });
    }
    // No-write outcomes: rejections never persist; already_resolved returns
    // the recorded resolution unchanged (redelivery short-circuit — no state
    // change, no revision bump, no event). The optional reply key preserves
    // the existing lossy rejection observation without asking storage to
    // decide the rejection.
    if (outcome.kind === "rejected") {
      LegacyObservationSink.publish(Wait.Events.ReplyRejected, {
        ...eventBase(outcome.record, outcome.at, traceId),
        code: outcome.code,
        ...(rejectionReplyKey === undefined ? {} : { replyKey: rejectionReplyKey }),
      });
      return outcome;
    }
    if (outcome.kind === "already_resolved") return outcome;
    const expectedRevision = outcome.record.revision - 1;
    if (current.revision !== expectedRevision) throw revisionConflict(id, expectedRevision);
    const fact = factOf(outcome);
    runWaitTransaction(id, () => {
      // Lazy adoption (#510 review fix F3): a pre-cutover wait row exists at
      // revision >= 1 with an EMPTY owner stream (its writes predate the
      // phase-B cutover). The coordinator adopts at the observed revision and
      // retries the append; a concurrent adopter loses the same race every
      // stale head loses. The genesis payload stays HERE because it is a persisted
      // Wait baseline: it mirrors wait.opened and deliberately carries NO
      // erasable data — the hash-chained ledger is immutable, so replies
      // (responder ids), correlation identifiers, and allowed-action/identity
      // fields must never be baked into it. The projection row remains the
      // read model for those.
      const committed = commitFact(
        ledger,
        {
          streamId: waitStreamId(id),
          expectedHead: expectedRevision,
          fact,
          adoption: {
            genesis: {
              type: "wait.adopted",
              data: {
                ownerKind: current.ownerRef.kind,
                ownerId: current.ownerRef.id,
                status: current.status,
                expiresAt: current.expiresAt,
                revision: current.revision,
              },
            },
          },
        },
        // A failed projection CAS is unreachable while every writer commits
        // through this coordinator (the append CAS and the projection CAS
        // guard the same head == revision); it stays as the explosive
        // backstop — the rollback discards the appended fact so head and
        // revision still agree.
        () => adapter.compareAndSet(id, expectedRevision, outcome.record) || false,
      );
      if (committed.kind !== "committed") throw revisionConflict(id, expectedRevision);
    });
    publishChange(outcome, traceId);
    return outcome;
  }

}
