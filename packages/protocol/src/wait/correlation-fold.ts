import type { Communication } from "../communication/index.js";
import type * as Schema from "./schema.js";

/**
 * Shared wait-correlation precedence core (batch ② commit 1). The full
 * lookup lives in the gateway router (@openomni/channels
 * router/wait/correlation.ts, `findWaitCandidates`) and the dispatch plane
 * keeps a read-only product slice
 * dispatch/frozen-interaction-correlation.ts,
 * `findFrozenPendingInteractionMatch`); the two may not import each other
 * (openomni↛channels = 0/0). Their PURE precedence logic — the scope pin
 * check, the pin-allows-claim gate, and the wait/legacy tier level builders —
 * was cloned and drifted (the legacy `externalMessageId` PendingAsk fallback
 * lived only on the channels side). It is hoisted here so both sides call ONE
 * core: the STORE READS (WaitStore / PendingInteractionStore / PendingAskStore
 * .findByCorrelation) and the per-side candidate reduction stay per-side.
 *
 * `externalMessageId` convergence: the shared `legacyTierLevels` takes the
 * unified `{ correlation?, externalMessageId? }` input and builds the
 * PendingAsk-only `externalMessageId` fallback level exactly as the channels
 * arm did. The dispatch arm passes no `externalMessageId`, so that branch is
 * inert there (identical output to today) — but the code path is now single
 * and cannot drift again (audit confirmed the field is absent at the dispatch
 * seam today; convergence keeps it structurally impossible to fail open).
 */

export type CorrelationLookup = Readonly<{
  correlation?: Schema.Correlation;
  externalMessageId?: string;
}>;

export type LegacyLevel = Readonly<{
  pendingInteraction: readonly Communication.PendingInteraction.CorrelationQuery[];
  pendingAsk: readonly Communication.PendingAsk.CorrelationQuery[];
}>;

/**
 * #498 C3: correlation input reuses THE one Wait.Correlation shape (all
 * fields optional). The endpoint+channel scope pins are required by every
 * producing seam (Command.Input / the ingress claim parse), so this explicit
 * presence check only narrows the type for the scoped queries below — it
 * never fires for a parsed envelope.
 */
function scopedPins(
  correlation: Schema.Correlation | undefined,
): Readonly<{ endpointId: string; channelId: string }> | undefined {
  if (correlation?.endpointId === undefined || correlation.channelId === undefined) {
    return undefined;
  }
  return { endpointId: correlation.endpointId, channelId: correlation.channelId };
}

/**
 * Channel scope is always enforced: a wait pinned to a channel only answers
 * claims of that channel. The endpoint pin is stricter only for a
 * single-responder wait — on a multi-responder wait the pinned endpoint is
 * the DELIVERY endpoint, while the other expected responders reply from
 * their OWN endpoints, so an endpoint mismatch must not exclude the row at
 * lookup. The matcher + fold remain the identity gate either way.
 */
export function waitPinsAllowClaim(
  record: Schema.Record,
  correlation: Schema.Correlation,
): boolean {
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

export function waitTierLevels(correlation: Schema.Correlation): Schema.CorrelationQuery[] {
  const levels: Schema.CorrelationQuery[] = [];
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

export function legacyTierLevels(input: CorrelationLookup): LegacyLevel[] {
  const levels: LegacyLevel[] = [];
  const correlation = input.correlation;
  // Legacy queries are always endpoint+channel scoped; a correlation without
  // both pins (impossible for a parsed envelope) reaches no legacy level.
  const scoped = scopedPins(correlation);

  if (scoped !== undefined && correlation?.replyToMessageId) {
    const query = { ...scoped, replyToMessageId: correlation.replyToMessageId };
    levels.push({ pendingInteraction: [query], pendingAsk: [query] });
  }
  if (scoped !== undefined && correlation?.threadId) {
    const query = { ...scoped, threadId: correlation.threadId };
    levels.push({ pendingInteraction: [query], pendingAsk: [query] });
  }
  if (scoped !== undefined && correlation?.tokenHash) {
    const query = { ...scoped, tokenHash: correlation.tokenHash };
    levels.push({ pendingInteraction: [query], pendingAsk: [query] });
  }

  const pendingInteractionFallback: Communication.PendingInteraction.CorrelationQuery[] = [];
  const pendingAskFallback: Communication.PendingAsk.CorrelationQuery[] = [];
  if (scoped !== undefined && correlation?.externalConversationId) {
    const query = { ...scoped, externalConversationId: correlation.externalConversationId };
    pendingInteractionFallback.push(query);
    pendingAskFallback.push(query);
  } else if (scoped !== undefined) {
    pendingInteractionFallback.push(scoped);
    pendingAskFallback.push(scoped);
  }
  if (input.externalMessageId) {
    pendingAskFallback.push(
      scoped === undefined
        ? { externalMessageId: input.externalMessageId }
        : { ...scoped, externalMessageId: input.externalMessageId },
    );
  }
  if (pendingInteractionFallback.length > 0 || pendingAskFallback.length > 0) {
    levels.push({
      pendingInteraction: pendingInteractionFallback,
      pendingAsk: pendingAskFallback,
    });
  }

  return levels;
}
