import { Delegation, type Storage as ProtocolStorage } from "@openomni/protocol";
import { Storage } from "../storage/storage";

function requireAdapter(): ProtocolStorage.DelegationSubAdapter {
  const adapter = Storage.get().delegation;
  if (adapter === undefined) {
    throw new Error(
      "Storage adapter does not implement delegation — durable delegation writes fail closed",
    );
  }
  return adapter;
}

/**
 * Durable delegation substrate. The kernel owns admission, settlement
 * authority, and events; this store only persists records and terminal CAS
 * receipts.
 */
export namespace DelegationStore {
  export type Record = Delegation.Record;

  /** Commits a delegation record before its transport is allowed to act. */
  export function create(record: Delegation.Record): Delegation.Record {
    const parsed = Delegation.Record.parse(record);
    if (!requireAdapter().create(parsed)) {
      throw new Error(`Delegation already exists: ${parsed.delegationId}`);
    }
    return parsed;
  }

  export function get(delegationId: string): Delegation.Record | undefined {
    return requireAdapter().get(delegationId);
  }

  /**
   * Settles open records exactly once. A losing caller receives the recorded
   * settlement, never its attempted replacement.
   */
  export function settle(
    delegationId: string,
    settlement: Delegation.Settled,
  ): Delegation.Settled | undefined {
    const parsed = Delegation.Settled.parse(settlement);
    const adapter = requireAdapter();
    if (adapter.compareAndSwapStatus(delegationId, parsed, parsed.at)) return parsed;
    return adapter.get(delegationId)?.settled;
  }

  export function listOpen(): Delegation.Record[] {
    return requireAdapter().listOpen();
  }

  export function countOpenByRoot(rootDelegationId: string): number {
    return requireAdapter().listOpenByRoot(rootDelegationId).length;
  }

  export function findByWaitId(waitId: string): Delegation.Record | undefined {
    return requireAdapter().findByWaitId(waitId);
  }
}
