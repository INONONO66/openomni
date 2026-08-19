import { Wait, type Communication } from "@openomni/protocol";
import { PendingAskStore, PendingInteractionStore, WaitStore } from "@openomni/ledger";

/**
 * Dispatch-side frozen PendingInteraction correlation (#707 stage 2).
 *
 * THE full correlation lookup lives in the gateway router
 * (@openomni/channels router/wait/correlation.ts) and the brain may not
 * import it (openomni→channels = 0). This module keeps the ONE slice the
 * dispatch plane needs — "does this correlation resolve to exactly one
 * frozen PendingInteraction row?" — over ledger reads of the frozen legacy
 * stores (recorded residue: writer domains are machine-enforced, frozen
 * reads tolerated) plus a read-only durable-wait shadow.
 *
 * Semantics are byte-frozen from the pre-flip findWaitCandidates fold:
 *   - the durable wait table is consulted first; ANY candidate at its
 *     winning precedence level (match or ambiguity) shadows the legacy tier
 *     — the correlation belongs to the wait plane, never a frozen row;
 *   - within the legacy tier, precedence levels are replyToMessageId >
 *     threadId > tokenHash > externalConversationId | scoped fallback, and
 *     PendingAsk rows at the same level count toward ambiguity;
 *   - exactly one candidate matches and it must be a PendingInteraction —
 *     anything more (or a PendingAsk winner) leaves the command unrouted, so
 *     the default dispatch authority denies it fail-closed.
 * The lookup never guesses and never writes (legacy rows are frozen).
 */

function waitTierShadows(correlation: Wait.Correlation): boolean {
  for (const query of Wait.waitTierLevels(correlation)) {
    const candidates = WaitStore.findByCorrelation(query).filter((record) =>
      Wait.waitPinsAllowClaim(record, correlation),
    );
    if (candidates.length > 0) return true;
  }
  return false;
}

export function findFrozenPendingInteractionMatch(
  correlation: Wait.Correlation,
): Communication.PendingInteraction.Record | undefined {
  if (waitTierShadows(correlation)) return undefined;
  // The dispatch slice passes NO externalMessageId (the private PendingAsk
  // externalMessageId fallback is a channels-only lookup) — the shared core's
  // that branch is inert here, so the level set is identical to the pre-hoist
  // dispatch fold, now on one drift-proof code path.
  for (const level of Wait.legacyTierLevels({ correlation })) {
    const byKey = new Map<string, Communication.PendingInteraction.Record | undefined>();
    for (const query of level.pendingInteraction) {
      for (const record of PendingInteractionStore.findByCorrelation(query)) {
        byKey.set(`pending_interaction:${record.id}`, record);
      }
    }
    for (const query of level.pendingAsk) {
      for (const record of PendingAskStore.findByCorrelation(query)) {
        byKey.set(`pending_ask:${record.id}`, undefined);
      }
    }
    if (byKey.size === 0) continue;
    if (byKey.size > 1) return undefined;
    const [only] = byKey.values();
    return only;
  }
  return undefined;
}
