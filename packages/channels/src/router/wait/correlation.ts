import { Wait, type Communication } from "@openomni/protocol";
import { PendingAskStore, PendingInteractionStore, WaitStore } from "@openomni/ledger";

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

type WaitCorrelationInput = Wait.CorrelationLookup;

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

function resolveWaitTier(input: WaitCorrelationInput): WaitResolution | undefined {
  const correlation = input.correlation;
  if (correlation === undefined) return undefined;
  for (const query of Wait.waitTierLevels(correlation)) {
    const resolution = resolveLevel(
      WaitStore.findByCorrelation(query)
        .filter((record) => Wait.waitPinsAllowClaim(record, correlation))
        .map((record) => ({ source: "wait", key: `wait:${record.id}`, wait: record }) as const),
    );
    if (resolution !== undefined) return resolution;
  }
  return undefined;
}

function resolveLegacyTier(input: WaitCorrelationInput): WaitResolution | undefined {
  for (const level of Wait.legacyTierLevels(input)) {
    const rawCandidates: WaitCandidate[] = [];
    for (const query of level.pendingInteraction) {
      for (const record of PendingInteractionStore.findByCorrelation(query)) {
        rawCandidates.push({
          source: "pending_interaction",
          key: `pending_interaction:${record.id}`,
          wait: Wait.waitViewOfPendingInteraction(record),
          record,
        });
      }
    }
    for (const query of level.pendingAsk) {
      for (const record of PendingAskStore.findByCorrelation(query)) {
        rawCandidates.push({
          source: "pending_ask",
          key: `pending_ask:${record.id}`,
          wait: Wait.waitViewOfPendingAsk(record),
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
