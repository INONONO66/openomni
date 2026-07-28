import { Communication } from "@openomni/protocol";
import { Bus } from "../bus";
import { Storage } from "../storage/storage";
import { requireSubAdapter, withCreateTimestamps } from "../storage/timestamped-store";

function requireAdapter() {
  return requireSubAdapter(
    Storage.get().pendingInteraction,
    "Storage adapter does not implement pendingInteraction",
  );
}

function eventBase(record: Communication.PendingInteraction.Record) {
  return {
    id: record.id,
    workerRunId: record.workerRunId,
    sessionId: record.sessionId,
    endpointId: record.endpointId,
    channelId: record.channelId,
    status: record.status,
    time: Date.now(),
  };
}

function nowRecord(
  input: Communication.PendingInteraction.Create,
): Communication.PendingInteraction.Record {
  return Communication.PendingInteraction.Record.parse(
    withCreateTimestamps({
      ...input,
      status: input.status ?? "open",
    }),
  );
}

function updateStatus(
  id: string,
  from: readonly Communication.PendingInteraction.Status[],
  status: Communication.PendingInteraction.Status,
  patch: Partial<Communication.PendingInteraction.Record> = {},
): { record: Communication.PendingInteraction.Record; changed: boolean } {
  const adapter = requireAdapter();
  const current = adapter.get(id);
  if (!current) throw new Error(`PendingInteraction not found: ${id}`);
  if (!from.includes(current.status)) return { record: current, changed: false };
  const updated = Communication.PendingInteraction.Record.parse({
    ...current,
    ...patch,
    status,
    updatedAt: Date.now(),
  });
  adapter.set(updated);
  return { record: updated, changed: true };
}

function stillAcceptsFollowUp(
  record: Communication.PendingInteraction.Record,
  now: number,
): boolean {
  if (record.status === "open") return now <= record.expiresAt;
  if (
    (record.status !== "resolved" && record.status !== "follow_up") ||
    record.resolvedAt === undefined
  ) {
    return false;
  }
  return now <= resolvedFollowUpUntil(record);
}

function resolvedFollowUpUntil(record: Communication.PendingInteraction.Record): number {
  return (record.resolvedAt ?? 0) + record.followUpWindow;
}

function isPastExpiry(record: Communication.PendingInteraction.Record, now: number): boolean {
  if (record.status === "open") return now > record.expiresAt;
  if (record.status === "resolved" || record.status === "follow_up") {
    return record.resolvedAt === undefined || now > resolvedFollowUpUntil(record);
  }
  return false;
}

export namespace PendingInteractionStore {
  export type Record = Communication.PendingInteraction.Record;

  export function create(input: Communication.PendingInteraction.Create): Record {
    const adapter = requireAdapter();
    const record = nowRecord(input);
    if (adapter.get(record.id)) {
      throw new Error(`PendingInteraction already exists: ${record.id}`);
    }
    adapter.create(record);
    Bus.publish(Communication.PendingInteraction.Events.Opened, eventBase(record));
    return record;
  }

  export function get(id: string): Record | undefined {
    return requireAdapter().get(id);
  }

  export function findByCorrelation(
    query: Communication.PendingInteraction.CorrelationQuery,
    now = Date.now(),
  ): Record[] {
    return requireAdapter()
      .findByCorrelation(Communication.PendingInteraction.CorrelationQuery.parse(query))
      .filter((record) => stillAcceptsFollowUp(record, now));
  }

  export function resolve(id: string, patch: Partial<Pick<Record, "resolvedAt">> = {}): Record {
    const resolvedAt = patch.resolvedAt ?? Date.now();
    const { record, changed } = updateStatus(id, ["open", "follow_up"], "resolved", {
      resolvedAt,
    });
    if (changed) {
      Bus.publish(Communication.PendingInteraction.Events.Resolved, {
        ...eventBase(record),
        resolvedAt,
      });
    }
    return record;
  }

  export function markFollowUp(id: string): Record {
    const current = get(id);
    if (!current) throw new Error(`PendingInteraction not found: ${id}`);
    if (current.status === "resolved" && Date.now() > resolvedFollowUpUntil(current)) {
      return expire(id);
    }
    const { record, changed } = updateStatus(id, ["resolved"], "follow_up");
    if (changed) {
      Bus.publish(Communication.PendingInteraction.Events.FollowUp, eventBase(record));
    }
    return record;
  }

  export function cancel(id: string, patch: Partial<Pick<Record, "cancelledAt">> = {}): Record {
    const cancelledAt = patch.cancelledAt ?? Date.now();
    const { record, changed } = updateStatus(id, ["open", "resolved", "follow_up"], "cancelled", {
      cancelledAt,
    });
    if (changed) {
      Bus.publish(Communication.PendingInteraction.Events.Cancelled, {
        ...eventBase(record),
        cancelledAt,
      });
    }
    return record;
  }

  function expire(id: string): Record {
    const { record, changed } = updateStatus(id, ["open", "resolved", "follow_up"], "expired");
    if (changed) {
      Bus.publish(Communication.PendingInteraction.Events.Expired, eventBase(record));
    }
    return record;
  }

  export function cleanupExpired(now = Date.now()): Record[] {
    return requireAdapter()
      .list(["open", "resolved", "follow_up"])
      .filter((record) => isPastExpiry(record, now))
      .map((record) => expire(record.id));
  }
}
