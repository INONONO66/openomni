import { Delegation, type Storage as ProtocolStorage } from "@openomni/protocol";
import { claimWithinCountedWindow } from "../storage/counted-window-claim.js";
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

  /** Atomically commits an open record only while its root has fanout capacity. */
  export function claimOpenWithinRoot(
    record: Delegation.Record,
    maxFanout: number,
  ): Delegation.Record | undefined {
    const parsed = Delegation.Record.parse(record);
    const adapter = requireAdapter();
    const result = claimWithinCountedWindow({
      transaction: (operation) => Storage.get().transaction(operation),
      alreadyClaimed: () => {
        const existing = adapter.get(parsed.delegationId);
        if (existing === undefined) return false;
        if (JSON.stringify(existing) !== JSON.stringify(parsed)) {
          throw new Error(`Delegation already exists: ${parsed.delegationId}`);
        }
        return true;
      },
      readWindowState: () => adapter.listOpenByRoot(parsed.rootDelegationId).length,
      canClaim: (openFanout) => openFanout < maxFanout,
      append: () => {
        if (!adapter.create(parsed)) {
          throw new Error(`Delegation already exists: ${parsed.delegationId}`);
        }
      },
    });
    return result === "claimed" ? parsed : undefined;
  }

  export function get(delegationId: string): Delegation.Record | undefined {
    return requireAdapter().get(delegationId);
  }

  /**
   * Settles an open record exactly once and exposes the CAS receipt. The
   * committed bit is necessary to keep event and wake emission exactly-once
   * even when two callers propose byte-for-byte identical settlements.
   */
  export function settleOnce(
    delegationId: string,
    settlement: Delegation.Settled,
  ): { readonly committed: boolean; readonly settlement?: Delegation.Settled } {
    const parsed = Delegation.Settled.parse(settlement);
    const adapter = requireAdapter();
    if (adapter.compareAndSwapStatus(delegationId, parsed, parsed.at)) {
      return { committed: true, settlement: parsed };
    }
    return { committed: false, settlement: adapter.get(delegationId)?.settled };
  }

  /**
   * Settles open records exactly once. A losing caller receives the recorded
   * settlement, never its attempted replacement.
   */
  export function settle(
    delegationId: string,
    settlement: Delegation.Settled,
  ): Delegation.Settled | undefined {
    return settleOnce(delegationId, settlement).settlement;
  }

  /** Records successful wake delivery once; false means another delivery already won. */
  export function markWoken(delegationId: string, wokenAt: number): boolean {
    return requireAdapter().compareAndSwapWoken(delegationId, wokenAt);
  }

  export function listOpen(): Delegation.Record[] {
    return requireAdapter().listOpen();
  }

  export function listSettledUnwoken(): Delegation.Record[] {
    return requireAdapter().listSettledUnwoken();
  }

  export function countOpenByRoot(rootDelegationId: string): number {
    return requireAdapter().listOpenByRoot(rootDelegationId).length;
  }

  export function findByWaitId(waitId: string): Delegation.Record | undefined {
    return requireAdapter().findByWaitId(waitId);
  }
}
