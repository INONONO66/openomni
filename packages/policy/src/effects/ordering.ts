import type { Policy } from "@openomni/protocol";
import type { EffectEntry, OrderedDecision } from "./types";
import { stableKey } from "./records";

export function orderDecisions(decisions: Policy.PolicyDecision[]): OrderedDecision[] {
  return decisions
    .map((decision, index) => ({ decision, priority: decisionPriority(decision), index }))
    .sort((left, right) => {
      if (left.priority !== right.priority) return left.priority - right.priority;
      const policyOrder = left.decision.policyId.localeCompare(right.decision.policyId);
      return policyOrder === 0 ? left.index - right.index : policyOrder;
    });
}

function decisionPriority(decision: Policy.PolicyDecision): number {
  if ("priority" in decision && typeof decision.priority === "number") return decision.priority;
  return 0;
}

export function uniquePolicyIds(policyIds: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const policyId of policyIds) {
    if (seen.has(policyId)) continue;
    seen.add(policyId);
    result.push(policyId);
  }

  return result;
}

export function collectEffectEntries(orderedDecisions: OrderedDecision[]): EffectEntry[] {
  const seenEffects = new Set<string>();
  const entries: Omit<EffectEntry, "order">[] = [];

  for (const ordered of orderedDecisions) {
    ordered.decision.effects.forEach((effect, effectIndex) => {
      const effectKey = stableKey(effect);
      if (seenEffects.has(effectKey)) return;

      seenEffects.add(effectKey);
      entries.push({
        effect,
        policyId: ordered.decision.policyId,
        priority: ordered.priority,
        decisionIndex: ordered.index,
        effectIndex,
      });
    });
  }

  return entries
    .sort((left, right) => {
      if (left.priority !== right.priority) return left.priority - right.priority;
      const policyOrder = left.policyId.localeCompare(right.policyId);
      if (policyOrder !== 0) return policyOrder;
      if (left.decisionIndex !== right.decisionIndex)
        return left.decisionIndex - right.decisionIndex;
      return left.effectIndex - right.effectIndex;
    })
    .map((entry, order) => ({ ...entry, order }));
}

export function collectSafeDenyEffects(orderedDecisions: OrderedDecision[]): Policy.PolicyEffect[] {
  return collectEffectEntries(orderedDecisions)
    .filter((entry) => entry.effect.type === "audit.annotate" || entry.effect.type === "run.abort")
    .map((entry) => entry.effect);
}

export function collectObligations(orderedDecisions: OrderedDecision[]): Policy.PolicyObligation[] {
  return orderedDecisions.flatMap(({ decision }) => decision.obligations ?? []);
}
