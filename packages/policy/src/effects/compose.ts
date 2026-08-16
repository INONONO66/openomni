import type { Policy } from "@openomni/protocol";

import { collectPreConflicts, conflictDiagnostic } from "./conflicts";
import { mergeEntries } from "./merge/rules";
import {
  collectEffectEntries,
  collectObligations,
  collectSafeDenyEffects,
  orderDecisions,
  uniquePolicyIds,
} from "./ordering";

export function composeEffects(decisions: Policy.PolicyDecision[]): Policy.EffectiveDecision {
  const orderedDecisions = orderDecisions(decisions);
  const contributingPolicies = uniquePolicyIds(
    orderedDecisions.map(({ decision }) => decision.policyId),
  );

  if (orderedDecisions.some(({ decision }) => decision.verdict === "deny")) {
    return {
      verdict: "deny",
      mergedEffects: collectSafeDenyEffects(orderedDecisions),
      obligations: [],
      contributingPolicies,
    };
  }

  const entries = collectEffectEntries(orderedDecisions);
  const preConflicts = collectPreConflicts(entries);
  if (preConflicts.length > 0) {
    return {
      verdict: "deny",
      mergedEffects: preConflicts.map(conflictDiagnostic),
      obligations: [],
      contributingPolicies,
    };
  }

  const merged = mergeEntries(entries);
  const verdict = orderedDecisions.some(({ decision }) => decision.verdict === "pending")
    ? "pending"
    : "allow";

  return {
    verdict,
    mergedEffects: merged.effects,
    obligations: verdict === "pending" ? collectObligations(orderedDecisions) : [],
    contributingPolicies,
  };
}
