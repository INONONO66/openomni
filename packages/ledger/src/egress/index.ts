/**
 * EgressBudgetStore: atomic active-egress counted-window claims (#219,
 * perimeter domain — gateway-design §4).
 *
 * Perimeter isolation (S8): consumed ONLY by the channels gateway router. A
 * missing sub-adapter fails closed; storage errors propagate before any send.
 */

import type { Gateway } from "@openomni/protocol";
import { Storage } from "../storage/storage";
import { requireSubAdapter } from "../storage/timestamped-store";

export namespace EgressBudgetStore {
  export type ClaimResult<Refusal> =
    | Readonly<{ kind: "claimed" }>
    | Readonly<{ kind: "refused"; reason: Refusal }>;

  function subAdapter(): NonNullable<Storage.Adapter["egressBudget"]> {
    return requireSubAdapter(
      Storage.get().egressBudget,
      "Storage adapter does not implement egressBudget — the active-egress gate fails closed",
    );
  }

  /** Read-only applicability projection; inbound admission never debits egress. */
  export function read(
    senderId: string,
    targetActorId: string,
    windowStartAt: number,
  ): Gateway.EgressDebitState {
    return subAdapter().read(senderId, targetActorId, windowStartAt);
  }

  /**
   * Atomically evaluate and append one counted-window claim. `windowStartAt`
   * is the caller's inclusive lower bound. The evaluator stays at the policy
   * boundary; the adapter only serializes projection-read + append.
   */
  export function claim<Refusal>(
    row: Gateway.EgressDebitRow,
    windowStartAt: number,
    evaluate: (state: Gateway.EgressDebitState) => "allow" | Refusal,
  ): ClaimResult<Refusal> {
    const refusals: Refusal[] = [];
    const result = subAdapter().claim(row, windowStartAt, (state) => {
      const verdict = evaluate(state);
      if (verdict === "allow") return true;
      refusals.push(verdict);
      return false;
    });
    return result === "claimed"
      ? { kind: "claimed" }
      : { kind: "refused", reason: refusals[0] as Refusal };
  }
}
