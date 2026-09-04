import type { Policy } from "@openomni/protocol";
import { PolicyDecision } from "@openomni/protocol";
import type {
  CanonicalPolicyRegistrationGeneric,
  GenericPolicyContext,
  PolicyEngineInstanceGeneric,
  PolicyPointId,
} from "../src/engine/types";

export const dispatchContext = {
  actor: { kind: "system", actorId: "system:test" },
  dispatchId: "dispatch-1",
  action: "resident.ask",
  target: { kind: "resident" },
  sessionId: "session-1",
  runId: "run-1",
  marker: { value: "original" },
} as const;

export function runContext() {
  return { sessionId: "session", runId: "run" };
}

export function turnPreContext() {
  return { ...runContext(), turnIndex: 0 };
}

export function turnPostContext() {
  return { ...turnPreContext(), turnResult: { type: "stop" } };
}

export function toolPreContext() {
  return { ...runContext(), toolId: "tool:native:test", toolInput: {} };
}

type PointRegistration = Omit<
  CanonicalPolicyRegistrationGeneric<GenericPolicyContext>,
  "kind" | "pointIds" | "effectCapabilities"
> & { readonly effects?: readonly Policy.PolicyEffectType[] };

export function atPoint(
  pointId: PolicyPointId,
  registration: PointRegistration,
): CanonicalPolicyRegistrationGeneric<GenericPolicyContext> {
  const { effects = [], ...rest } = registration;
  return {
    kind: "point",
    pointIds: [pointId],
    effectCapabilities: { [pointId]: effects },
    ...rest,
  };
}

export function registerAt(
  engine: Pick<PolicyEngineInstanceGeneric<GenericPolicyContext>, "add">,
  pointId: PolicyPointId,
  registration: PointRegistration,
): void {
  engine.add(atPoint(pointId, registration));
}

export function allow(policyId = "test.allow"): Policy.PolicyDecision {
  return PolicyDecision.allow({ policyId });
}
