import { Delegation, type Storage as ProtocolStorage } from "@openomni/protocol";

/**
 * Map-backed Delegation sub-adapter for isolated store consumers. Production
 * storage is SQLite; this adapter keeps the same insert and terminal-CAS
 * receipts for tests and narrow in-memory compositions.
 */
export function createMemoryDelegationAdapter(): ProtocolStorage.DelegationSubAdapter {
  const records = new Map<string, Delegation.Record>();

  return {
    create(record) {
      const parsed = Delegation.Record.parse(record);
      if (records.has(parsed.delegationId)) return false;
      if (
        parsed.waitId !== undefined &&
        [...records.values()].some((candidate) => candidate.waitId === parsed.waitId)
      ) {
        return false;
      }
      records.set(parsed.delegationId, parsed);
      return true;
    },
    get(delegationId) {
      const record = records.get(delegationId);
      return record === undefined ? undefined : Delegation.Record.parse(record);
    },
    compareAndSwapStatus(delegationId, settled, settledAt) {
      const current = records.get(delegationId);
      if (current === undefined || current.status !== "open") return false;
      const next = Delegation.Record.parse({
        ...current,
        status: "settled",
        settled,
        settledAt,
      });
      records.set(delegationId, next);
      return true;
    },
    compareAndSwapWoken(delegationId, wokenAt) {
      const current = records.get(delegationId);
      if (current === undefined || current.status !== "settled" || current.wokenAt !== undefined) {
        return false;
      }
      records.set(delegationId, Delegation.Record.parse({ ...current, wokenAt }));
      return true;
    },
    listOpen() {
      return list(records.values());
    },
    listSettledUnwoken() {
      return [...records.values()]
        .filter((record) => record.status === "settled" && record.wokenAt === undefined)
        .sort((left, right) => (left.settledAt ?? 0) - (right.settledAt ?? 0))
        .map((record) => Delegation.Record.parse(record));
    },
    listOpenByRoot(rootDelegationId) {
      return list(
        [...records.values()].filter(
          (record) => record.status === "open" && record.rootDelegationId === rootDelegationId,
        ),
      );
    },
    findByWaitId(waitId) {
      const record = [...records.values()].find((candidate) => candidate.waitId === waitId);
      return record === undefined ? undefined : Delegation.Record.parse(record);
    },
  };
}

function list(records: Iterable<Delegation.Record>): Delegation.Record[] {
  return [...records]
    .filter((record) => record.status === "open")
    .sort((left, right) => left.createdAt - right.createdAt)
    .map((record) => Delegation.Record.parse(record));
}
