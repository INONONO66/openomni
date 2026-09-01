import { Conversation, Lease, type Storage as ProtocolStorage } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { isSqliteBusyError } from "../storage/sqlite-busy";
import { Storage } from "../storage/storage";

// Durable Lease writes fail closed: a missing sub-adapter is a typed error,
// never warn-and-return — the same law the conversation store ships.
function requireAdapter(): ProtocolStorage.LeaseSubAdapter {
  const adapter = Storage.get().lease;
  if (!adapter) {
    throw new Lease.StoreError({
      message: "Storage adapter does not implement lease — durable Lease writes fail closed",
      code: "adapter_absent",
    });
  }
  return adapter;
}

function requireConversationAdapter(): ProtocolStorage.ConversationSubAdapter {
  const adapter = Storage.get().conversation;
  if (!adapter) {
    throw new Lease.StoreError({
      message:
        "Storage adapter does not implement conversation — durable Lease writes fail closed",
      code: "adapter_absent",
    });
  }
  return adapter;
}

/**
 * Every Lease state change is a decision-class fact on the owner stream
 * `lease:<id>` and awaits its durable append before the projection write
 * (no record, no action). Head↔revision binding mirrors the conversation
 * stream: fact seq N produced projected revision N, `expectedHead` is the
 * revision BEFORE the transition, and append + projection CAS commit inside
 * ONE sync immediate storage transaction. No adoption path — the stream
 * class is born post-cutover.
 */
function requireLedger(): ProtocolStorage.LedgerSubAdapter {
  const ledger = Storage.get().ledger;
  if (!ledger) {
    throw new Lease.StoreError({
      message:
        "Storage adapter does not implement ledger append — durable Lease writes fail closed",
      code: "adapter_absent",
    });
  }
  return ledger;
}

function streamId(leaseId: string): string {
  return `lease:${leaseId}`;
}

function conversationStreamId(conversationId: string): string {
  return `conversation:${conversationId}`;
}

function revisionConflict(leaseId: string, expected: number): InstanceType<typeof Lease.StoreError> {
  return new Lease.StoreError({
    message: `Lease revision conflict: ${leaseId} expected=${expected}`,
    code: "revision_conflict",
    leaseId,
  });
}

/** SQLITE_BUSY at the transaction entry means nothing committed — typed `unavailable`. */
function runLeaseTransaction<T>(leaseId: string, write: () => T): T {
  try {
    return Storage.get().transaction(write);
  } catch (error) {
    if (isSqliteBusyError(error)) {
      throw new Lease.StoreError({
        message: `Lease storage busy: ${leaseId} — ${error instanceof Error ? error.message : String(error)}`,
        code: "unavailable",
        leaseId,
      });
    }
    throw error;
  }
}

// Every lease event inherits its caller's trace — no mint in the store (D11).
function eventBase(record: Lease.Record, traceId: string, time: number) {
  return {
    traceId,
    leaseId: record.id,
    conversationId: record.conversationId,
    holderDelegationId: record.holderDelegationId,
    time,
  };
}

/** What the caller supplies at issuance; contactId and expiresAt are derived. */
type IssueInput = Readonly<{
  id: string;
  conversationId: string;
  holderDelegationId: string;
  /** The holding delegation's deadline — the lease never outlives it. */
  delegationDeadline: number;
  maxOutbound: number;
}>;

type SendDebitOutcome =
  | Readonly<{ kind: "debited"; lease: Lease.Record; conversation: Conversation.Record }>
  | Readonly<{
      kind: "refused";
      reason: Lease.DebitRefusalReason | `conversation_${Conversation.OutboundRefusalReason}`;
    }>;

export namespace LeaseStore {
  export type Record = Lease.Record;

  /**
   * Issues a lease: the carve (§3.3) is enforced HERE, atomically with the
   * create — sum(live leases' allocations on the conversation) + the new
   * allocation never exceeds the window's remaining outbound cap, the
   * conversation must be open, and the lease's expiry is
   * min(conversation.expiresAt, delegation.deadline). All inside one
   * transaction with the lease.issued fact append (record-before-act).
   */
  export function issue(input: IssueInput, traceId: string, at = Date.now()): Lease.Record {
    const adapter = requireAdapter();
    const conversationAdapter = requireConversationAdapter();
    const ledger = requireLedger();
    let issued: Lease.Record | undefined;
    runLeaseTransaction(input.id, () => {
      const conversation = conversationAdapter.get(input.conversationId);
      if (conversation === undefined || conversation.state !== "open") {
        throw new Lease.StoreError({
          message: `Lease ${input.id} cannot carve from missing or closed conversation ${input.conversationId}`,
          code: "conversation_closed",
          leaseId: input.id,
        });
      }
      const reserved =
        conversation.outboundUsed +
        adapter
          .listLiveByConversation(input.conversationId, at)
          .reduce((sum, lease) => sum + lease.budget.maxOutbound, 0);
      if (reserved + input.maxOutbound > conversation.policy.maxOutbound) {
        throw new Lease.StoreError({
          message: `Lease ${input.id} carve ${input.maxOutbound} exceeds conversation ${input.conversationId} remaining cap ${conversation.policy.maxOutbound - reserved}`,
          code: "carve_exceeded",
          leaseId: input.id,
        });
      }
      const record = Lease.issue(
        {
          id: input.id,
          conversationId: input.conversationId,
          holderDelegationId: input.holderDelegationId,
          contactId: conversation.contactId,
          maxOutbound: input.maxOutbound,
          expiresAt: Math.min(conversation.policy.expiresAt, input.delegationDeadline),
        },
        at,
      );
      const duplicate = () =>
        new Lease.StoreError({
          message: `Lease already exists for id ${record.id}`,
          code: "duplicate",
          leaseId: record.id,
        });
      const appended = ledger.append(
        {
          streamId: streamId(record.id),
          type: "lease.issued",
          data: {
            conversationId: record.conversationId,
            holderDelegationId: record.holderDelegationId,
            contactId: record.contactId,
            maxOutbound: record.budget.maxOutbound,
            expiresAt: record.expiresAt,
            revision: record.revision,
          },
        },
        0,
      );
      if (appended.kind === "cas_conflict") throw duplicate();
      if (!adapter.create(record)) throw duplicate();
      issued = record;
    });
    if (issued === undefined) {
      throw new Lease.StoreError({
        message: `Lease issuance for ${input.id} produced no record`,
        code: "unavailable",
        leaseId: input.id,
      });
    }
    Bus.publish(Lease.Events.Issued, {
      ...eventBase(issued, traceId, issued.createdAt),
      contactId: issued.contactId,
      maxOutbound: issued.budget.maxOutbound,
      expiresAt: issued.expiresAt,
    });
    return issued;
  }

  export function get(id: string): Lease.Record | undefined {
    return requireAdapter().get(id);
  }

  export function list(state?: Lease.State[]): Lease.Record[] {
    return requireAdapter().list(state);
  }

  export function listLiveByConversation(conversationId: string, now = Date.now()): Lease.Record[] {
    return requireAdapter().listLiveByConversation(conversationId, now);
  }

  /** The admission-relaxation read: live leases a worker delegation holds. */
  export function listLiveByHolder(holderDelegationId: string, now = Date.now()): Lease.Record[] {
    return requireAdapter().listLiveByHolder(holderDelegationId, now);
  }

  /**
   * THE lease-send debit (§3.5 + the §4 accounting table): one atomic
   * transaction folds BOTH the lease's carved allocation and the scoped
   * conversation's outbound cap, then appends both facts and lands both
   * projections. A refusal at either fold writes nothing — the two counters
   * can never drift apart.
   */
  export function sendDebit(leaseId: string, at = Date.now()): SendDebitOutcome {
    const adapter = requireAdapter();
    const conversationAdapter = requireConversationAdapter();
    const ledger = requireLedger();
    const lease = adapter.get(leaseId);
    if (!lease) {
      throw new Lease.StoreError({
        message: `Lease not found: ${leaseId}`,
        code: "not_found",
        leaseId,
      });
    }
    const leaseOutcome = Lease.debit(lease, at);
    if (leaseOutcome.kind === "refused") {
      return { kind: "refused", reason: leaseOutcome.reason };
    }
    let outcome: SendDebitOutcome | undefined;
    runLeaseTransaction(leaseId, () => {
      const conversation = conversationAdapter.get(lease.conversationId);
      if (conversation === undefined) {
        throw new Lease.StoreError({
          message: `Lease ${leaseId} conversation ${lease.conversationId} is missing`,
          code: "conversation_closed",
          leaseId,
        });
      }
      const conversationOutcome = Conversation.admitOutbound(conversation, at);
      if (conversationOutcome.kind === "refused") {
        outcome = { kind: "refused", reason: `conversation_${conversationOutcome.reason}` };
        return;
      }
      const debited = leaseOutcome.record;
      const leaseAppended = ledger.append(
        {
          streamId: streamId(leaseId),
          type: "lease.debited",
          data: { outboundUsed: debited.budget.outboundUsed, revision: debited.revision },
        },
        lease.revision,
      );
      if (leaseAppended.kind === "cas_conflict") throw revisionConflict(leaseId, lease.revision);
      const admitted = conversationOutcome.record;
      const conversationAppended = ledger.append(
        {
          streamId: conversationStreamId(conversation.id),
          type: "conversation.outbound_admitted",
          data: { outboundUsed: admitted.outboundUsed, revision: admitted.revision },
        },
        conversation.revision,
      );
      if (conversationAppended.kind === "cas_conflict") {
        throw revisionConflict(leaseId, lease.revision);
      }
      if (!adapter.compareAndSet(leaseId, lease.revision, debited)) {
        throw revisionConflict(leaseId, lease.revision);
      }
      if (
        !conversationAdapter.compareAndSet(conversation.id, conversation.revision, admitted)
      ) {
        throw revisionConflict(leaseId, lease.revision);
      }
      outcome = { kind: "debited", lease: debited, conversation: admitted };
    });
    if (outcome === undefined) {
      throw new Lease.StoreError({
        message: `Lease send debit for ${leaseId} produced no outcome`,
        code: "unavailable",
        leaseId,
      });
    }
    return outcome;
  }

  /** Idempotent: closing a closed lease returns `unchanged` with the first settlement. */
  export function close(
    id: string,
    closedBy: Lease.ClosedBy,
    traceId: string,
    at = Date.now(),
  ): Lease.CloseOutcome {
    const adapter = requireAdapter();
    const ledger = requireLedger();
    const current = adapter.get(id);
    if (!current) {
      throw new Lease.StoreError({
        message: `Lease not found: ${id}`,
        code: "not_found",
        leaseId: id,
      });
    }
    const outcome = Lease.close(current, closedBy, at);
    if (outcome.kind === "unchanged") return outcome;
    runLeaseTransaction(id, () => {
      const appended = ledger.append(
        {
          streamId: streamId(id),
          type: "lease.closed",
          data: { closedBy, revision: outcome.record.revision },
        },
        current.revision,
      );
      if (appended.kind === "cas_conflict") throw revisionConflict(id, current.revision);
      if (!adapter.compareAndSet(id, current.revision, outcome.record)) {
        throw revisionConflict(id, current.revision);
      }
    });
    Bus.publish(Lease.Events.Closed, {
      ...eventBase(outcome.record, traceId, outcome.record.updatedAt),
      closedBy,
    });
    return outcome;
  }

  /** The delegation-lifecycle inverse: settle/cancel/deadline kills the holder's leases. */
  export function closeByHolder(
    holderDelegationId: string,
    closedBy: Lease.ClosedBy,
    traceId: string,
    at = Date.now(),
  ): number {
    const live = requireAdapter().listLiveByHolder(holderDelegationId, at);
    for (const lease of live) {
      close(lease.id, closedBy, traceId, at);
    }
    return live.length;
  }

  /** The spatial inverse: a revoked conversation reactively kills its leases (§3.5). */
  export function closeByConversation(
    conversationId: string,
    closedBy: Lease.ClosedBy,
    traceId: string,
    at = Date.now(),
  ): number {
    const live = requireAdapter().listLiveByConversation(conversationId, at);
    for (const lease of live) {
      close(lease.id, closedBy, traceId, at);
    }
    return live.length;
  }
}
