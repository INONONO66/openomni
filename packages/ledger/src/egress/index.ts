/**
 * EgressBudgetStore: the active-egress debit ledger (#219, perimeter domain —
 * gateway-design §4). Records ADMITTED proactive sends and folds the window
 * projection the pure budget evaluator consumes.
 *
 * Perimeter isolation (S8): consumed ONLY by the channels gateway router (the
 * send kernel), exactly like the wait store — the brain never reaches it. A
 * missing sub-adapter fails closed: the egress gate must never fabricate an
 * "admitted" answer.
 *
 * Record-before-act: the debit is written when a send is ADMITTED (not
 * suppressed), so split outreach across separate calls cannot evade the cap and
 * the cooldown clock survives a restart.
 */

import type { Gateway } from "@openomni/protocol";
import { requireSubAdapter } from "../storage/timestamped-store";
import { Storage } from "../storage/storage";

export namespace EgressBudgetStore {
  function subAdapter(): NonNullable<Storage.Adapter["egressBudget"]> {
    return requireSubAdapter(
      Storage.get().egressBudget,
      "Storage adapter does not implement egressBudget — the active-egress gate fails closed",
    );
  }

  /** Append one admitted-send debit row (record-before-act). */
  export function record(row: Gateway.EgressDebitRow): void {
    subAdapter().record(row);
  }

  /**
   * Fold the window projection for one (sender, target) pair. `windowStartAt`
   * is the caller's `at - budget.windowMs`; `lastSendAt` is window-independent
   * (the cooldown clock runs off the most recent admitted send).
   */
  export function readState(
    senderId: string,
    targetActorId: string,
    windowStartAt: number,
  ): Gateway.EgressDebitState {
    return subAdapter().readState(senderId, targetActorId, windowStartAt);
  }
}
