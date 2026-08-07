import type { Communication, Dispatch, Wait } from "@openomni/protocol";
import { PendingAskStore, PendingInteractionStore, WaitStore } from "@openomni/session";
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

export type WaitCandidate =
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

export type WaitCorrelationInput = Readonly<{
  correlation?: Dispatch.Correlation;
  externalMessageId?: string;
}>;

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
 * A wait row that pins an endpoint or channel only answers inbound claims of
 * that same endpoint/channel; unpinned rows (multi-responder waits) match on
 * the distinguishing field alone.
 */
function waitPinsAllowClaim(record: Wait.Record, correlation: Dispatch.Correlation): boolean {
  return (
    (record.correlation.endpointId === undefined ||
      record.correlation.endpointId === correlation.endpointId) &&
    (record.correlation.channelId === undefined ||
      record.correlation.channelId === correlation.channelId)
  );
}

function waitTierLevels(correlation: Dispatch.Correlation): Wait.CorrelationQuery[] {
  const levels: Wait.CorrelationQuery[] = [];
  if (correlation.replyToMessageId) levels.push({ replyToMessageId: correlation.replyToMessageId });
  if (correlation.threadId) levels.push({ threadId: correlation.threadId });
  if (correlation.tokenHash) levels.push({ tokenHash: correlation.tokenHash });
  if (correlation.externalConversationId) {
    levels.push({ externalConversationId: correlation.externalConversationId });
  } else {
    levels.push({ endpointId: correlation.endpointId, channelId: correlation.channelId });
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
  pendingInteraction: readonly Dispatch.Correlation[];
  pendingAsk: readonly Communication.PendingAsk.CorrelationQuery[];
}>;

function legacyTierLevels(input: WaitCorrelationInput): LegacyLevel[] {
  const levels: LegacyLevel[] = [];
  const correlation = input.correlation;
  const scoped =
    correlation === undefined
      ? undefined
      : { endpointId: correlation.endpointId, channelId: correlation.channelId };

  if (correlation?.replyToMessageId) {
    const query = {
      endpointId: correlation.endpointId,
      channelId: correlation.channelId,
      replyToMessageId: correlation.replyToMessageId,
    };
    levels.push({ pendingInteraction: [query], pendingAsk: [query] });
  }
  if (correlation?.threadId) {
    const query = {
      endpointId: correlation.endpointId,
      channelId: correlation.channelId,
      threadId: correlation.threadId,
    };
    levels.push({ pendingInteraction: [query], pendingAsk: [query] });
  }
  if (correlation?.tokenHash) {
    const query = {
      endpointId: correlation.endpointId,
      channelId: correlation.channelId,
      tokenHash: correlation.tokenHash,
    };
    levels.push({ pendingInteraction: [query], pendingAsk: [query] });
  }

  const pendingInteractionFallback: Dispatch.Correlation[] = [];
  const pendingAskFallback: Communication.PendingAsk.CorrelationQuery[] = [];
  if (correlation?.externalConversationId) {
    const query = {
      endpointId: correlation.endpointId,
      channelId: correlation.channelId,
      externalConversationId: correlation.externalConversationId,
    };
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
