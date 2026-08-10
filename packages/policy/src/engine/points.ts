import { Policy } from "@openomni/protocol";
import type { PolicyPointId } from "./types";

class PolicyPointTimingError extends Error {
  constructor(pointId: string) {
    super(`Registered policy point has no canonical timing: ${pointId}`);
    this.name = "PolicyPointTimingError";
  }
}

/** Fail-closed dispatch rejection for grid-retired points (#530). */
class PolicyPointRetiredError extends Error {
  constructor(readonly pointId: string) {
    super(`Policy point is retired from the dispatch grid: ${pointId}`);
    this.name = "PolicyPointRetiredError";
  }
}

/**
 * #530 points disposition: `session.inbound.pre` and `session.writeback.pre`
 * are declared in the protocol point registry but have zero dispatchers and
 * zero registrants repo-wide, and their only plausible dispatcher — the
 * kernel ingress boundary — cannot satisfy their contracts honestly
 * (`actorId` is required but anonymous senders are legal at ingress by
 * design; `runId` is required but resident/cancel writebacks span zero or
 * many runs). The kernel runs its own gates (openomni ingress/policy-gate)
 * instead, so both points are retired from the dispatch grid: registration
 * and dispatch at them fail closed. The protocol-side contracts are not
 * edited here — redesigning the admission-point input schema is flagged as
 * protocol work in #530.
 */
type RetiredPolicyPointId = "session.inbound.pre" | "session.writeback.pre";
const retiredPolicyPoints: ReadonlySet<string> = new Set<RetiredPolicyPointId>([
  "session.inbound.pre",
  "session.writeback.pre",
]);

export function isRetiredPolicyPoint(pointId: string): boolean {
  return retiredPolicyPoints.has(pointId);
}

const canonicalTimingEntries = {
  "dispatch.action.pre": Policy.Timing.DISPATCH_AUTHORIZE,
  "run.lifecycle.pre": Policy.Timing.RUN_START,
  "run.turn.pre": Policy.Timing.TURN_START,
  "prompt.context.pre": Policy.Timing.CONTEXT_PREPARE,
  "tool.catalog.pre": Policy.Timing.RESOURCES_PREPARE,
  "connection.llm.pre": Policy.Timing.MODEL_REQUEST,
  "connection.llm.post": Policy.Timing.MODEL_RESPONSE,
  "tool.native.pre": Policy.Timing.INVOKE_PREPARE,
  "tool.mcp.pre": Policy.Timing.INVOKE_PREPARE,
  "delegation.worker.pre": Policy.Timing.INVOKE_PREPARE,
  "tool.native.post": Policy.Timing.INVOKE_RESULT,
  "tool.mcp.post": Policy.Timing.INVOKE_RESULT,
  "delegation.worker.post": Policy.Timing.INVOKE_RESULT,
  "run.turn.post": Policy.Timing.TURN_FINISH,
  "run.completion.pre": Policy.Timing.COMPLETION_PREPARE,
  "work.complete.pre": Policy.Timing.COMPLETION_PREPARE,
  "run.lifecycle.post": Policy.Timing.RUN_FINISH,
  "run.error.error": Policy.Timing.ERROR,
} satisfies Readonly<Record<Exclude<PolicyPointId, RetiredPolicyPointId>, Policy.Timing>>;
const canonicalTimingByPointId: ReadonlyMap<string, Policy.Timing> = new Map(
  Object.entries(canonicalTimingEntries),
);

export function timingForPolicyPoint(pointId: PolicyPointId): Policy.Timing {
  const contract = Policy.PolicyPoint.Registry[pointId];
  if (contract === undefined) throw new PolicyPointTimingError(pointId);
  if (isRetiredPolicyPoint(contract.id)) throw new PolicyPointRetiredError(contract.id);
  const timing = canonicalTimingByPointId.get(contract.id);
  if (timing !== undefined) return timing;
  throw new PolicyPointTimingError(contract.id);
}

export function allowedEffectTypesAtPoint(
  pointId: PolicyPointId,
): ReadonlySet<Policy.PolicyEffectType> {
  return new Set(Policy.PolicyPoint.Registry[pointId].allowedEffects);
}
