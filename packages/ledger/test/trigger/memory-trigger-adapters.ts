import { Ledger, Trigger, type Storage as ProtocolStorage } from "@openomni/protocol";

export type MemoryTriggerAdapters = Readonly<{
  trigger: ProtocolStorage.TriggerSubAdapter;
  triggerFire: ProtocolStorage.TriggerFireSubAdapter;
  ledger: ProtocolStorage.LedgerSubAdapter;
  transaction<T>(operation: () => T): T;
}>;

/**
 * Map-backed Trigger projections for the shared store contract. Production is
 * SQLite-only; this pair mirrors its insert/CAS receipts, ordering, parsing,
 * cloning, and transaction rollback semantics without becoming a fallback.
 */
export function createMemoryTriggerAdapters(): MemoryTriggerAdapters {
  let triggers = new Map<string, Trigger.Record>();
  let fires = new Map<string, Trigger.Fire>();
  let facts = new Map<string, Ledger.RecordedFact[]>();
  let heads = new Map<string, number>();
  let transactionDepth = 0;

  const listTriggers = (filter?: ProtocolStorage.TriggerListFilter): Trigger.Record[] => {
    const direction = filter?.order === "newest" ? -1 : 1;
    return [...triggers.values()]
      .filter(
        (record) =>
          (filter?.ownerSessionId === undefined ||
            record.ownerSessionId === filter.ownerSessionId) &&
          (!filter?.states?.length || filter.states.includes(record.lifecycle.state)) &&
          (!filter?.kinds?.length || filter.kinds.includes(record.source.kind)),
      )
      .sort(
        (left, right) =>
          direction * (left.createdAt - right.createdAt || compareText(left.id, right.id)),
      )
      .slice(0, listLimit(filter?.limit))
      .map(cloneTrigger);
  };

  const trigger: ProtocolStorage.TriggerSubAdapter = {
    create(record) {
      const parsed = cloneTrigger(record);
      if (triggers.has(parsed.id)) return false;
      triggers.set(parsed.id, parsed);
      return true;
    },
    get(id) {
      const record = triggers.get(id);
      return record === undefined ? undefined : cloneTrigger(record);
    },
    list: listTriggers,
    listIds(filter) {
      return listTriggers(filter).map((record) => record.id);
    },
    listActiveIds() {
      return [...triggers.values()]
        .filter((record) => record.lifecycle.state !== "ended")
        .sort((left, right) => left.createdAt - right.createdAt || compareText(left.id, right.id))
        .map((record) => record.id);
    },
    countActiveByOwner(ownerSessionId) {
      return [...triggers.values()].filter(
        (record) => record.ownerSessionId === ownerSessionId && record.lifecycle.state !== "ended",
      ).length;
    },
    compareAndSet(id, expectedRevision, record) {
      const parsed = cloneTrigger(record);
      if (parsed.id !== id) {
        throw new Error(`Trigger id mismatch: key=${id} payload=${parsed.id}`);
      }
      if (parsed.revision !== expectedRevision + 1) {
        throw new Error(
          `Trigger revision must advance exactly once: expected=${expectedRevision} payload=${parsed.revision}`,
        );
      }
      if (triggers.get(id)?.revision !== expectedRevision) return false;
      triggers.set(id, parsed);
      return true;
    },
  };

  const triggerFire: ProtocolStorage.TriggerFireSubAdapter = {
    create(record) {
      const parsed = cloneFire(record);
      if (fires.has(parsed.id)) return false;
      if (!triggers.has(parsed.triggerId)) {
        throw new Error(`Trigger Fire parent is missing: ${parsed.triggerId}`);
      }
      fires.set(parsed.id, parsed);
      return true;
    },
    get(id) {
      const record = fires.get(id);
      return record === undefined ? undefined : cloneFire(record);
    },
    list(filter) {
      return [...fires.values()]
        .filter(
          (record) =>
            (filter?.triggerId === undefined || record.triggerId === filter.triggerId) &&
            (filter?.ownerSessionId === undefined ||
              record.ownerSessionId === filter.ownerSessionId) &&
            (!filter?.statuses?.length || filter.statuses.includes(record.status)),
        )
        .sort((left, right) => left.recordedAt - right.recordedAt || compareText(left.id, right.id))
        .slice(0, listLimit(filter?.limit))
        .map(cloneFire);
    },
    compareAndSet(id, expectedRevision, record) {
      const parsed = cloneFire(record);
      if (parsed.id !== id) {
        throw new Error(`Trigger Fire id mismatch: key=${id} payload=${parsed.id}`);
      }
      if (parsed.revision !== expectedRevision + 1) {
        throw new Error(
          `Trigger Fire revision must advance exactly once: expected=${expectedRevision} payload=${parsed.revision}`,
        );
      }
      if (fires.get(id)?.revision !== expectedRevision) return false;
      fires.set(id, parsed);
      return true;
    },
    listUnackedIds() {
      return [...fires.values()]
        .filter((record) => record.status === "recorded" || record.status === "delivered")
        .sort((left, right) => left.recordedAt - right.recordedAt || compareText(left.id, right.id))
        .map((record) => record.id);
    },
  };

  const ledger: ProtocolStorage.LedgerSubAdapter = {
    append(input, expectedHead) {
      const parsed = Ledger.Input.parse(input);
      const stream = facts.get(parsed.streamId) ?? [];
      const currentHead = heads.get(parsed.streamId) ?? 0;
      if (currentHead !== expectedHead) {
        return { kind: "cas_conflict", currentHead };
      }
      const fact = Ledger.RecordedFact.parse({
        streamId: parsed.streamId,
        seq: expectedHead + 1,
        type: parsed.type,
        data: parsed.data,
        timeCreated: parsed.timeCreated ?? 0,
      });
      facts.set(parsed.streamId, [...stream, fact]);
      heads.set(parsed.streamId, fact.seq);
      return { kind: "appended", seq: fact.seq, eventHash: "0".repeat(64) };
    },
    adoptStream(streamId, headRevision, genesis) {
      const currentHead = heads.get(streamId) ?? 0;
      if (currentHead > 0) {
        throw new Ledger.AdoptError({
          message: `Stream is not empty: ${streamId}`,
          streamId,
          currentHead,
        });
      }
      const parsed = Ledger.AdoptGenesis.parse(genesis);
      facts.set(streamId, [
        Ledger.RecordedFact.parse({
          streamId,
          seq: headRevision,
          type: parsed.type,
          data: parsed.data,
          timeCreated: parsed.timeCreated ?? 0,
        }),
      ]);
      heads.set(streamId, headRevision);
    },
    headFact(streamId) {
      return cloneFact(facts.get(streamId)?.at(-1));
    },
    factsByType(type) {
      return [...facts.values()]
        .flat()
        .filter((fact) => fact.type === type)
        .sort((left, right) => compareText(left.streamId, right.streamId) || left.seq - right.seq)
        .map((fact) => cloneFact(fact) as Ledger.RecordedFact);
    },
  };

  return {
    trigger,
    triggerFire,
    ledger,
    transaction<T>(operation: () => T): T {
      if (transactionDepth > 0) return operation();
      const triggerSnapshot = new Map(triggers);
      const fireSnapshot = new Map(fires);
      const factSnapshot = new Map([...facts].map(([streamId, stream]) => [streamId, [...stream]]));
      const headSnapshot = new Map(heads);
      transactionDepth += 1;
      try {
        return operation();
      } catch (error) {
        triggers = triggerSnapshot;
        fires = fireSnapshot;
        facts = factSnapshot;
        heads = headSnapshot;
        throw error;
      } finally {
        transactionDepth -= 1;
      }
    },
  };
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function listLimit(limit: number | undefined): number {
  const value = limit ?? Trigger.Constants.MAX_TRIGGER_LIST_ROWS;
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > Trigger.Constants.MAX_TRIGGER_LIST_ROWS
  ) {
    throw new RangeError(
      `Trigger list limit must be in 1..${Trigger.Constants.MAX_TRIGGER_LIST_ROWS}`,
    );
  }
  return value;
}

function cloneTrigger(record: Trigger.Record): Trigger.Record {
  return Trigger.Record.parse(record);
}

function cloneFire(record: Trigger.Fire): Trigger.Fire {
  return Trigger.Fire.parse(record);
}

function cloneFact(record: Ledger.RecordedFact | undefined): Ledger.RecordedFact | undefined {
  return record === undefined ? undefined : Ledger.RecordedFact.parse(record);
}
