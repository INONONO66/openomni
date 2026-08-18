import type { Communication, Wait } from "@openomni/protocol";
import { PendingAskStore, PendingInteractionStore, WaitStore } from "@openomni/ledger";
import { waitViewOfPendingAsk, waitViewOfPendingInteraction } from "./upcast.js";

/**
 * THE one correlation lookup (#215): the durable wait table is consulted
 * first; frozen legacy rows (PendingInteraction / PendingAsk) answer only
 * when the wait table has no candidate. Within the winning precedence level
 * a single candidate matches and anything more is a typed ambiguity — the
 * lookup never guesses and never writes (legacy rows are frozen; ambiguity
 * is recorded by the routing decision, not by mutating candidates).
 *
 * Precedence levels (most specific first, both tiers):
 *   replyToMessageId > threadId > tokenHash > externalConversationId |
 *   scoped endpoint+channel fallback (+ the PendingAsk-only private
 *   externalMessageId lookup in the legacy tier).
 */

type WaitCandidate =
  | Readonly<{ source: "wait"; key: `wait:${string}`; wait: Wait.Record }>
  | Readonly<{
      source: "pending_interaction";
      key: `pending_interaction:${string}`;
      wait: Wait.Record;
      record: Communication.PendingInteraction.Record;
    }>
  | Readonly<{
      source: "pending_ask";
      key: `pending_ask:${string}`;
      wait: Wait.Record;
      record: Communication.PendingAsk.Record;
    }>;

type WaitCorrelationInput = Readonly<{
  correlation?: Wait.Correlation;
  externalMessageId?: string;
}>;

/**
 * #498 C3: correlation input reuses THE one Wait.Correlation shape (all
 * fields optional). The endpoint+channel scope pins are required by every
 * producing seam (Command.Input / the ingress claim parse), so this explicit
 * presence check only narrows the type for the scoped queries below — it
 * never fires for a parsed envelope.
 */
function scopedPins(
  correlation: Wait.Correlation | undefined,
): Readonly<{ endpointId: string; channelId: string }> | undefined {
  if (correlation?.endpointId === undefined || correlation.channelId === undefined) {
    return undefined;
  }
  return { endpointId: correlation.endpointId, channelId: correlation.channelId };
}

export type WaitResolution =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "match"; candidate: WaitCandidate }>
  | Readonly<{ kind: "ambiguous"; candidates: readonly WaitCandidate[] }>;

function resolveLevel(rawCandidates: readonly WaitCandidate[]): WaitResolution | undefined {
  const candidates = [
    ...new Map(rawCandidates.map((candidate) => [candidate.key, candidate])).values(),
  ].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  if (candidates.length === 0) return undefined;
  const [candidate, ...rest] = candidates;
  if (candidate !== undefined && rest.length === 0) return { kind: "match", candidate };
  return { kind: "ambiguous", candidates };
}

/**
 * Channel scope is always enforced: a wait pinned to a channel only answers
 * claims of that channel. The endpoint pin is stricter only for a
 * single-responder wait — on a multi-responder wait the pinned endpoint is
 * the DELIVERY endpoint, while the other expected responders reply from
 * their OWN endpoints, so an endpoint mismatch must not exclude the row at
 * lookup. The matcher + fold remain the identity gate either way.
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

function resolveWaitTier(input: WaitCorrelationInput): WaitResolution | undefined {
  const correlation = input.correlation;
  if (correlation === undefined) return undefined;
  for (const query of waitTierLevels(correlation)) {
    const resolution = resolveLevel(
      WaitStore.findByCorrelation(query)
        .filter((record) => waitPinsAllowClaim(record, correlation))
        .map((record) => ({ source: "wait", key: `wait:${record.id}`, wait: record }) as const),
    );
    if (resolution !== undefined) return resolution;
  }
  return undefined;
}

type LegacyLevel = Readonly<{
  pendingInteraction: readonly Communication.PendingInteraction.CorrelationQuery[];
  pendingAsk: readonly Communication.PendingAsk.CorrelationQuery[];
}>;

function legacyTierLevels(input: WaitCorrelationInput): LegacyLevel[] {
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

function resolveLegacyTier(input: WaitCorrelationInput): WaitResolution | undefined {
  for (const level of legacyTierLevels(input)) {
    const rawCandidates: WaitCandidate[] = [];
    for (const query of level.pendingInteraction) {
      for (const record of PendingInteractionStore.findByCorrelation(query)) {
        rawCandidates.push({
          source: "pending_interaction",
          key: `pending_interaction:${record.id}`,
          wait: waitViewOfPendingInteraction(record),
          record,
        });
      }
    }
    for (const query of level.pendingAsk) {
      for (const record of PendingAskStore.findByCorrelation(query)) {
        rawCandidates.push({
          source: "pending_ask",
          key: `pending_ask:${record.id}`,
          wait: waitViewOfPendingAsk(record),
          record,
        });
      }
    }
    const resolution = resolveLevel(rawCandidates);
    if (resolution !== undefined) return resolution;
  }
  return undefined;
}

export function findWaitCandidates(input: WaitCorrelationInput): WaitResolution {
  return resolveWaitTier(input) ?? resolveLegacyTier(input) ?? { kind: "none" };
}
