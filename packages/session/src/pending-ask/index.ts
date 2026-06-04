import { Communication } from "@openomni/protocol";
import { Bus } from "../bus";
import { Storage } from "../storage/storage";

function requireAdapter() {
  const adapter = Storage.get().pendingAsk;
  if (!adapter) throw new Error("Storage adapter does not implement pendingAsk");
  return adapter;
}

function eventBase(record: Communication.PendingAsk.Record) {
  return {
    id: record.id,
    status: record.status,
    originSessionId: record.originSessionId,
    ...(record.originRunId ? { originRunId: record.originRunId } : {}),
    targetKind: record.targetKind,
    time: Date.now(),
  };
}

function nowRecord(input: Communication.PendingAsk.Create): Communication.PendingAsk.Record {
  const now = Date.now();
  return Communication.PendingAsk.Record.parse({
    ...input,
    status: input.status ?? "open",
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? input.createdAt ?? now,
  });
}

function updateStatus(
  id: string,
  statuses: readonly Communication.PendingAsk.Status[],
  status: Communication.PendingAsk.Status,
  patch: Partial<Communication.PendingAsk.Record> = {},
): { record: Communication.PendingAsk.Record; changed: boolean } {
  const adapter = requireAdapter();
  const current = adapter.get(id);
  if (!current) throw new Error(`PendingAsk not found: ${id}`);
  if (!statuses.includes(current.status)) {
    return { record: current, changed: false };
  }
  const updated = Communication.PendingAsk.Record.parse({
    ...current,
    ...patch,
    status,
    updatedAt: Date.now(),
  });
  adapter.set(updated);
  return { record: updated, changed: true };
}

export namespace PendingAskStore {
  export type Record = Communication.PendingAsk.Record;
  export type Create = Communication.PendingAsk.Create;
  export type Status = Communication.PendingAsk.Status;
  export type CorrelationQuery = Communication.PendingAsk.CorrelationQuery;

  export function create(input: Create): Record {
    const adapter = requireAdapter();
    const record = nowRecord(input);
    if (adapter.get(record.id)) throw new Error(`PendingAsk already exists: ${record.id}`);
    adapter.create(record);
    Bus.publish(Communication.PendingAsk.Events.Opened, eventBase(record));
    return record;
  }

  export function get(id: string): Record | undefined {
    return requireAdapter().get(id);
  }

  export function list(status?: Status[]): Record[] {
    return requireAdapter().list(status);
  }

  export function findByCorrelation(query: CorrelationQuery): Record[] {
    return requireAdapter().findByCorrelation(
      Communication.PendingAsk.CorrelationQuery.parse(query),
    );
  }

  export function answer(id: string, patch: Partial<Pick<Record, "answeredAt">> = {}): Record {
    const answeredAt = patch.answeredAt ?? Date.now();
    const { record, changed } = updateStatus(id, ["open", "ambiguous"], "answered", {
      answeredAt,
    });
    if (changed) {
      Bus.publish(Communication.PendingAsk.Events.Answered, {
        ...eventBase(record),
        answeredAt,
      });
    }
    return record;
  }

  export function markAmbiguous(id: string): Record {
    const { record, changed } = updateStatus(id, ["open"], "ambiguous");
    if (changed) {
      Bus.publish(Communication.PendingAsk.Events.Ambiguous, eventBase(record));
    }
    return record;
  }

  export function cancel(id: string): Record {
    const { record, changed } = updateStatus(id, ["open", "ambiguous"], "cancelled");
    if (changed) {
      Bus.publish(Communication.PendingAsk.Events.Cancelled, eventBase(record));
    }
    return record;
  }

  export function expire(id: string): Record {
    const { record, changed } = updateStatus(id, ["open", "ambiguous"], "expired");
    if (changed) {
      Bus.publish(Communication.PendingAsk.Events.Expired, eventBase(record));
    }
    return record;
  }

  export function remove(id: string): boolean {
    return requireAdapter().remove(id);
  }
}
