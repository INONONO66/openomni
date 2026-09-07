import type * as Schema from "./schema.js";

/**
 * Shared wait-correlation precedence core: the PURE precedence logic — the
 * scope pin check, the pin-allows-claim gate, and the tier level builder —
 * behind the gateway router's full lookup (@openomni/channels
 * router/wait/correlation.ts, `findWaitCandidates`). The STORE READS
 * (WaitStore.findByCorrelation) and the candidate reduction stay caller-side.
 */

/**
 * #498 C3: correlation input reuses THE one Wait.Correlation shape (all
 * fields optional). The endpoint+channel scope pins are required by the
 * producing seam (the ingress claim parse), so this explicit presence check
 * only narrows the type for the scoped queries below — it never fires for a
 * parsed envelope.
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
  const replies = new Set([
    ...(correlation.replyToMessageId === undefined ? [] : [correlation.replyToMessageId]),
    ...(correlation.chain ?? []),
  ]);
  for (const replyToMessageId of replies) levels.push({ replyToMessageId });
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
