import { Wait, type Storage as ProtocolStorage } from "@openomni/protocol";
import { Bus } from "../bus";
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

function eventBase(record: Wait.Record, time: number) {
  return {
    id: record.id,
    ownerKind: record.ownerRef.kind,
    ownerId: record.ownerRef.id,
    status: record.status,
    time,
  };
}

function stillCorrelatable(record: Wait.Record, now: number): boolean {
  if (record.status === "open") return now <= record.expiresAt;
  if (record.status === "resolved" && record.resolvedAt !== undefined) {
    return now <= record.resolvedAt + record.followUpWindow;
  }
  return false;
}

function publishChange(outcome: Exclude<Wait.Outcome, { kind: "rejected" }>): void {
  const base = eventBase(outcome.record, outcome.record.updatedAt);
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
  }
}

export namespace WaitStore {
  export type Record = Wait.Record;

  export function create(input: Wait.Create): Wait.Record {
    const adapter = requireAdapter();
    // Single write-shape owner: this Record.parse is the factory that
    // enforces resolution-policy coherence (see Wait.Create doc).
    const record = Wait.Record.parse(
      withCreateTimestamps({
        ...input,
        status: "open",
        partial: false,
        replies: [],
        revision: 0,
      }),
    );
    if (!adapter.create(record)) {
      throw new Wait.StoreError({
        message: `Wait already exists for id ${record.id} or originMessageId ${record.originMessageId}`,
        code: "duplicate",
        waitId: record.id,
      });
    }
    Bus.publish(Wait.Events.Opened, eventBase(record, record.createdAt));
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
   * Persists one fold outcome under a revision compare-and-set. Rejected
   * outcomes write nothing; state changes must land with `changes === 1` or
   * the transition throws a typed revision_conflict.
   */
  export function transition(
    id: string,
    step: (record: Wait.Record) => Wait.Outcome,
  ): Wait.Outcome {
    const adapter = requireAdapter();
    const current = adapter.get(id);
    if (!current) {
      throw new Wait.StoreError({
        message: `Wait not found: ${id}`,
        code: "not_found",
        waitId: id,
      });
    }
    const outcome = step(current);
    if (outcome.kind === "rejected") return outcome;
    if (!adapter.compareAndSet(id, current.revision, outcome.record)) {
      throw new Wait.StoreError({
        message: `Wait revision conflict: ${id} expected=${current.revision}`,
        code: "revision_conflict",
        waitId: id,
      });
    }
    publishChange(outcome);
    return outcome;
  }

  export function attachReply(id: string, input: Wait.ReplyInput): Wait.Outcome {
    const parsed = Wait.ReplyInput.parse(input);
    const outcome = transition(id, (record) => Wait.attachReply(record, parsed));
    if (outcome.kind === "rejected") {
      Bus.publish(Wait.Events.ReplyRejected, {
        ...eventBase(outcome.record, outcome.at),
        code: outcome.code,
        replyKey: parsed.replyKey,
      });
    }
    return outcome;
  }

  export function expire(id: string, at = Date.now()): Wait.Outcome {
    return transition(id, (record) => Wait.expire(record, { at }));
  }

  export function cancel(id: string, at = Date.now()): Wait.Outcome {
    return transition(id, (record) => Wait.cancel(record, { at }));
  }
}
