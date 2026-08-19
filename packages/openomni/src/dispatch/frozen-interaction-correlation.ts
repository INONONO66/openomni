import type { Communication, Wait } from "@openomni/protocol";
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

function scopedPins(
  correlation: Wait.Correlation,
): Readonly<{ endpointId: string; channelId: string }> | undefined {
  if (correlation.endpointId === undefined || correlation.channelId === undefined) {
    return undefined;
  }
  return { endpointId: correlation.endpointId, channelId: correlation.channelId };
}

/**
 * Channel scope is always enforced; the endpoint pin is stricter only for a
 * single-responder wait (multi-responder waits pin the DELIVERY endpoint,
 * while other expected responders reply from their own endpoints).
 */
function waitPinsAllowClaim(record: Wait.Record, correlation: Wait.Correlation): boolean {
  if (
    record.correlation.channelId !== undefined &&
    record.correlation.channelId !== correlation.channelId
  ) {
    return false;
  }
  if (record.expectedResponders.length > 1) return true;
  return (
    record.correlation.endpointId === undefined ||
    record.correlation.endpointId === correlation.endpointId
  );
}

function waitTierLevels(correlation: Wait.Correlation): Wait.CorrelationQuery[] {
  const levels: Wait.CorrelationQuery[] = [];
  if (correlation.replyToMessageId) levels.push({ replyToMessageId: correlation.replyToMessageId });
  if (correlation.threadId) levels.push({ threadId: correlation.threadId });
  if (correlation.tokenHash) levels.push({ tokenHash: correlation.tokenHash });
  if (correlation.externalConversationId) {
    levels.push({ externalConversationId: correlation.externalConversationId });
  } else {
    const scoped = scopedPins(correlation);
    if (scoped !== undefined) levels.push(scoped);
  }
  return levels;
}

function waitTierShadows(correlation: Wait.Correlation): boolean {
  for (const query of waitTierLevels(correlation)) {
    const candidates = WaitStore.findByCorrelation(query).filter((record) =>
      waitPinsAllowClaim(record, correlation),
    );
    if (candidates.length > 0) return true;
  }
  return false;
}

type LegacyLevel = Readonly<{
  pendingInteraction: readonly Communication.PendingInteraction.CorrelationQuery[];
  pendingAsk: readonly Communication.PendingAsk.CorrelationQuery[];
}>;

function legacyTierLevels(correlation: Wait.Correlation): LegacyLevel[] {
  const levels: LegacyLevel[] = [];
  // Legacy queries are always endpoint+channel scoped; a correlation without
  // both pins (impossible for a parsed envelope) reaches no legacy level.
  const scoped = scopedPins(correlation);
  if (scoped === undefined) return levels;

  if (correlation.replyToMessageId) {
    const query = { ...scoped, replyToMessageId: correlation.replyToMessageId };
    levels.push({ pendingInteraction: [query], pendingAsk: [query] });
  }
  if (correlation.threadId) {
    const query = { ...scoped, threadId: correlation.threadId };
    levels.push({ pendingInteraction: [query], pendingAsk: [query] });
  }
  if (correlation.tokenHash) {
    const query = { ...scoped, tokenHash: correlation.tokenHash };
    levels.push({ pendingInteraction: [query], pendingAsk: [query] });
  }
  const fallback = correlation.externalConversationId
    ? { ...scoped, externalConversationId: correlation.externalConversationId }
    : scoped;
  levels.push({ pendingInteraction: [fallback], pendingAsk: [fallback] });
  return levels;
}

export function findFrozenPendingInteractionMatch(
  correlation: Wait.Correlation,
): Communication.PendingInteraction.Record | undefined {
  if (waitTierShadows(correlation)) return undefined;
  for (const level of legacyTierLevels(correlation)) {
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
