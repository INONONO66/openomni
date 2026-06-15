import { PolicyDecision, type Ingress, type Policy } from "@openomni/protocol";
import type { PreRunState } from "./ingress-authority-types";

export function allowDecision(policyId: string, reason: string): Policy.PolicyDecision {
  return PolicyDecision.allow({ policyId, reasonCodes: [reason] });
}

export function abortDecision(policyId: string, reason: string): Policy.PolicyDecision {
  return PolicyDecision.deny({
    policyId,
    reasonCodes: [reason],
    effects: [{ type: "run.abort", reason }],
  });
}

export function requireParsedEvent(state: PreRunState): Ingress.InboundEvent {
  if (!state.parsedEvent) {
    throw new Error("ingress event must be schema-validated before authority middleware");
  }
  return state.parsedEvent;
}

export function throwAbort(decision: Policy.PolicyDecision, state: PreRunState): never {
  if (state.schemaError) throw state.schemaError;
  throw new Error(PolicyDecision.reason(decision, "ingress run.start middleware aborted"));
}
