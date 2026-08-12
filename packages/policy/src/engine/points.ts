import { Policy } from "@openomni/protocol";
import type { PolicyPointId } from "./types";

class PolicyPointTimingError extends Error {
  constructor(pointId: string) {
    super(`Registered policy point has no canonical timing: ${pointId}`);
    this.name = "PolicyPointTimingError";
  }
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
} satisfies Readonly<Record<PolicyPointId, Policy.Timing>>;
const canonicalTimingByPointId: ReadonlyMap<string, Policy.Timing> = new Map(
  Object.entries(canonicalTimingEntries),
);

export function timingForPolicyPoint(pointId: PolicyPointId): Policy.Timing {
  const contract = Policy.PolicyPoint.Registry[pointId];
  if (contract === undefined) throw new PolicyPointTimingError(pointId);
  const timing = canonicalTimingByPointId.get(contract.id);
  if (timing !== undefined) return timing;
  throw new PolicyPointTimingError(contract.id);
}

export function allowedEffectTypesAtPoint(
  pointId: PolicyPointId,
): ReadonlySet<Policy.PolicyEffectType> {
  return new Set(Policy.PolicyPoint.Registry[pointId].allowedEffects);
}
