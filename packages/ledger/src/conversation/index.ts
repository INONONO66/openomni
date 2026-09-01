import { Conversation, type Storage as ProtocolStorage } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { isSqliteBusyError } from "../storage/sqlite-busy";
import { Storage } from "../storage/storage";

// Durable Conversation writes fail closed: a missing sub-adapter is a typed
// error, never warn-and-return — the same law the wait store ships.
function requireAdapter(): ProtocolStorage.ConversationSubAdapter {
  const adapter = Storage.get().conversation;
  if (!adapter) {
    throw new Conversation.StoreError({
      message:
        "Storage adapter does not implement conversation — durable Conversation writes fail closed",
      code: "adapter_absent",
    });
  }
  return adapter;
}

/**
 * Every Conversation state change is a decision-class fact on the owner
 * stream `conversation:<id>` and awaits its durable append before the
 * projection write (no record, no action). Head↔revision binding mirrors the
 * wait stream: fact seq N produced projected revision N, `expectedHead` is
 * the revision BEFORE the transition, and append + projection CAS commit
 * inside ONE sync immediate storage transaction. No adoption path — the
 * stream class is born post-cutover, so an empty stream under a projected
 * row is a defect, never legacy.
 */
function requireLedger(): ProtocolStorage.LedgerSubAdapter {
  const ledger = Storage.get().ledger;
  if (!ledger) {
    throw new Conversation.StoreError({
      message:
        "Storage adapter does not implement ledger append — durable Conversation writes fail closed",
      code: "adapter_absent",
    });
  }
  return ledger;
}

function streamId(conversationId: string): string {
  return `conversation:${conversationId}`;
}

function revisionConflict(
  conversationId: string,
  expected: number,
): InstanceType<typeof Conversation.StoreError> {
  return new Conversation.StoreError({
    message: `Conversation revision conflict: ${conversationId} expected=${expected}`,
    code: "revision_conflict",
    conversationId,
  });
}

/** SQLITE_BUSY at the transaction entry means nothing committed — typed `unavailable`. */
function runConversationTransaction<T>(conversationId: string, write: () => T): T {
  try {
    return Storage.get().transaction(write);
  } catch (error) {
    if (isSqliteBusyError(error)) {
      throw new Conversation.StoreError({
        message: `Conversation storage busy: ${conversationId} — ${error instanceof Error ? error.message : String(error)}`,
        code: "unavailable",
        conversationId,
      });
    }
    throw error;
  }
}

type Outcome = Conversation.CloseOutcome | Conversation.OutboundOutcome | Conversation.InboundOutcome;
type CommittedOutcome = Extract<Outcome, { record: Conversation.Record }> & {
  kind: "closed" | "admitted" | "recorded" | "cap_breached" | "already_breached";
};

/**
 * Decision-class fact for one committed fold outcome: typed fields plus the
 * resulting revision — never the record snapshot (the projection row remains
 * the read model, and the hash-chained ledger must carry no erasable data).
 */
function factOf(outcome: CommittedOutcome): { type: string; data: Record<string, unknown> } {
  const revision = outcome.record.revision;
  switch (outcome.kind) {
    case "closed":
      return {
        type: "conversation.closed",
        data: { closedBy: outcome.record.closedBy, revision },
      };
    case "admitted":
      return {
        type: "conversation.outbound_admitted",
        data: { outboundUsed: outcome.record.outboundUsed, revision },
      };
    case "cap_breached":
      return {
        type: "conversation.cap_breached",
        data: { inboundUsed: outcome.record.inboundUsed, revision },
      };
    case "recorded":
    case "already_breached":
      return {
        type: "conversation.inbound_recorded",
        data: { inboundUsed: outcome.record.inboundUsed, revision },
      };
  }
}

// Every conversation event inherits its caller's trace — no mint in the
// store (D11, the wait-store law).
function eventBase(record: Conversation.Record, traceId: string, time: number) {
  return {
    traceId,
    conversationId: record.id,
    contactId: record.contactId,
    endpointId: record.endpointId,
    time,
  };
}

// Bus stays observe-only: lossy projections of the appended facts, fired
// only AFTER the transaction committed. CapBreached fires exactly once per
// window — the fold reports only the first crossing as `cap_breached`.
function publishChange(outcome: CommittedOutcome, traceId: string): void {
  const base = eventBase(outcome.record, traceId, outcome.record.updatedAt);
  if (outcome.kind === "closed") {
    Bus.publish(Conversation.Events.Closed, {
      ...base,
      closedBy: outcome.record.closedBy ?? "owner",
    });
    return;
  }
  if (outcome.kind === "cap_breached") {
    Bus.publish(Conversation.Events.CapBreached, base);
  }
}

export namespace ConversationStore {
  export type Record = Conversation.Record;

  export function open(
    input: Conversation.Create,
    traceId: string,
    at = Date.now(),
  ): Conversation.Record {
    const adapter = requireAdapter();
    const ledger = requireLedger();
    // Single write-shape owner: Conversation.open is the factory (revision 1
    // — the conversation.opened fact is seq 1, so head === revision from birth).
    const record = Conversation.open(input, at);
    const duplicate = () =>
      new Conversation.StoreError({
        message: `Conversation already exists for id ${record.id}`,
        code: "duplicate",
        conversationId: record.id,
      });
    runConversationTransaction(record.id, () => {
      const appended = ledger.append(
        {
          streamId: streamId(record.id),
          type: "conversation.opened",
          data: {
            contactId: record.contactId,
            endpointId: record.endpointId,
            ownerKind: record.ownerRef.kind,
            ownerId: record.ownerRef.id,
            openedBy: record.openedBy,
            expiresAt: record.policy.expiresAt,
            revision: record.revision,
          },
        },
        0,
      );
      // A non-empty stream means this id was already opened; a failed INSERT
      // receipt aborts the transaction, rolling the appended fact back.
      if (appended.kind === "cas_conflict") throw duplicate();
      if (!adapter.create(record)) throw duplicate();
    });
    Bus.publish(Conversation.Events.Opened, {
      ...eventBase(record, traceId, record.createdAt),
      openedBy: record.openedBy,
      expiresAt: record.policy.expiresAt,
    });
    return record;
  }

  export function get(id: string): Conversation.Record | undefined {
    return requireAdapter().get(id);
  }

  export function list(state?: Conversation.State[]): Conversation.Record[] {
    return requireAdapter().list(state);
  }

  /** Open windows pinned to one endpoint — the router's inbound correlation read. */
  export function findOpenByEndpoint(endpointId: string): Conversation.Record[] {
    return requireAdapter().findOpenByEndpoint(endpointId);
  }

  /**
   * Persists one fold outcome: fact append FIRST (expectedHead = revision
   * before the transition), then the projection under a revision
   * compare-and-set, both in one transaction. No-write outcomes (idempotent
   * close, outbound refusals) return without touching storage.
   */
  function transition(
    id: string,
    traceId: string,
    step: (record: Conversation.Record) => Outcome,
  ): Outcome {
    const adapter = requireAdapter();
    const ledger = requireLedger();
    const current = adapter.get(id);
    if (!current) {
      throw new Conversation.StoreError({
        message: `Conversation not found: ${id}`,
        code: "not_found",
        conversationId: id,
      });
    }
    const outcome = step(current);
    if (outcome.kind === "unchanged" || outcome.kind === "refused") return outcome;
    const fact = factOf(outcome);
    runConversationTransaction(id, () => {
      const appended = ledger.append(
        { streamId: streamId(id), type: fact.type, data: fact.data },
        current.revision,
      );
      if (appended.kind === "cas_conflict") throw revisionConflict(id, current.revision);
      if (!adapter.compareAndSet(id, current.revision, outcome.record)) {
        // Unreachable while every writer goes through this transaction; kept
        // as the explosive backstop — rollback discards the appended fact so
        // head and revision still agree.
        throw revisionConflict(id, current.revision);
      }
    });
    publishChange(outcome, traceId);
    return outcome;
  }

  /** Idempotent: closing a closed window returns `unchanged` with the first settlement. */
  export function close(
    id: string,
    closedBy: Conversation.ClosedBy,
    traceId: string,
    at = Date.now(),
  ): Conversation.CloseOutcome {
    return transition(id, traceId, (record) =>
      Conversation.close(record, closedBy, at),
    ) as Conversation.CloseOutcome;
  }

  /** The conversational send right: one durable outbound debit per admitted send. */
  export function admitOutbound(
    id: string,
    traceId: string,
    at = Date.now(),
  ): Conversation.OutboundOutcome {
    return transition(id, traceId, (record) =>
      Conversation.admitOutbound(record, at),
    ) as Conversation.OutboundOutcome;
  }

  /** Counts an inbound delivery; the first cap crossing publishes the one owner wake. */
  export function recordInbound(
    id: string,
    traceId: string,
    at = Date.now(),
  ): Conversation.InboundOutcome {
    return transition(id, traceId, (record) =>
      Conversation.recordInbound(record, at),
    ) as Conversation.InboundOutcome;
  }
}
