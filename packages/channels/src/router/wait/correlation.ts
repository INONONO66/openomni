import { Wait } from "@openomni/protocol";
import { WaitStore } from "@openomni/ledger";

/**
 * THE one correlation lookup (#215) over the durable wait table. Within the
 * winning precedence level a single candidate matches and anything more is a
 * typed ambiguity — the lookup never guesses and never writes (ambiguity is
 * recorded by the routing decision, not by mutating candidates).
 *
 * Precedence levels (most specific first):
 *   replyToMessageId > threadId > tokenHash > externalConversationId |
 *   scoped endpoint+channel fallback.
 */

type WaitCandidate = Readonly<{ key: `wait:${string}`; wait: Wait.Record }>;

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

export function findWaitCandidates(correlation: Wait.Correlation | undefined): WaitResolution {
  if (correlation === undefined) return { kind: "none" };
  for (const query of Wait.waitTierLevels(correlation)) {
    const resolution = resolveLevel(
      WaitStore.findByCorrelation(query)
        .filter((record) => Wait.waitPinsAllowClaim(record, correlation))
        .map((record) => ({ key: `wait:${record.id}`, wait: record }) as const),
    );
    if (resolution !== undefined) return resolution;
  }
  return { kind: "none" };
}
