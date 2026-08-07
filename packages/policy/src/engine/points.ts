import { Policy, type RuntimeResource } from "@openomni/protocol";
import type { PolicyPointId } from "./types";

class PolicyPointTimingError extends Error {
  constructor(pointId: string) {
    super(`Registered policy point has no canonical timing: ${pointId}`);
    this.name = "PolicyPointTimingError";
  }
}

class PolicyPointResolutionError extends Error {
  constructor(readonly timing: Policy.Timing) {
    super(`No canonical policy points map to timing: ${timing}`);
    this.name = "PolicyPointResolutionError";
  }
}

const canonicalMigrationMapping: ReadonlyMap<Policy.Timing, readonly PolicyPointId[]> = new Map(
  Object.values(Policy.Timing).map((timing) => [
    timing,
    Object.freeze([...Policy.PolicyPoint.MigrationMapping[timing]]),
  ]),
);

export function resolvePolicyPoints(
  timing: Policy.Timing,
  context?: { readonly resourceKind?: string },
): PolicyPointId[] {
  const pointIds = canonicalMigrationMapping.get(timing);
  if (pointIds === undefined) throw new PolicyPointResolutionError(timing);

  const resourceKind = context?.resourceKind;
  if (resourceKind === undefined) return [...pointIds];

  return pointIds.filter((pointId) =>
    Policy.PolicyPoint.Registry[pointId].resourceKinds.includes(resourceKind),
  );
}

const canonicalTimingEntries = {
  "session.inbound.pre": Policy.Timing.INBOUND_RECEIVE,
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
  "session.writeback.pre": Policy.Timing.WRITEBACK_COMMIT,
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

export function policyPointIdsForDescriptor(
  timing: Policy.Timing,
  descriptor: RuntimeResource.Descriptor | undefined,
): PolicyPointId[] {
  const aliases = resolvePolicyPoints(timing);
  if (descriptor === undefined) return aliases;

  if (timing === "invoke.prepare") {
    if (descriptor.kind === "worker") {
      return ["delegation.worker.pre"];
    }
    if (descriptor.kind === "tool") {
      return descriptor.source?.type === "mcp" || descriptor.source?.type === "skill-mcp"
        ? ["tool.mcp.pre"]
        : ["tool.native.pre"];
    }
  }

  if (timing === "invoke.result") {
    if (descriptor.kind === "worker") {
      return ["delegation.worker.post"];
    }
    if (descriptor.kind === "tool") {
      return descriptor.source?.type === "mcp" || descriptor.source?.type === "skill-mcp"
        ? ["tool.mcp.post"]
        : ["tool.native.post"];
    }
  }

  return aliases;
}

export function auditPoint(
  timing: Policy.Timing,
  descriptor: RuntimeResource.Descriptor | undefined,
): { readonly pointId?: PolicyPointId; readonly pointVersion?: number } {
  const pointId = policyPointIdsForDescriptor(timing, descriptor)[0];
  if (pointId === undefined) return {};

  return { pointId, pointVersion: Policy.PolicyPoint.Registry[pointId].version };
}

export function defaultFailPolicy(
  timing: Policy.Timing,
  descriptor: RuntimeResource.Descriptor | undefined,
): Policy.FailPolicy {
  const pointId = policyPointIdsForDescriptor(timing, descriptor)[0];
  if (pointId === undefined) return "fail-open";
  return Policy.PolicyPoint.Registry[pointId].defaultFailPolicy;
}

export function allowedEffectTypes(
  timing: Policy.Timing,
  descriptor: RuntimeResource.Descriptor | undefined,
): Map<Policy.PolicyEffectType, PolicyPointId> {
  const allowed = new Map<Policy.PolicyEffectType, PolicyPointId>();

  for (const pointId of policyPointIdsForDescriptor(timing, descriptor)) {
    const point = Policy.PolicyPoint.Registry[pointId];
    for (const effectType of point.allowedEffects) {
      if (!allowed.has(effectType)) allowed.set(effectType, pointId);
    }
  }

  return allowed;
}

export function allowedEffectTypesAtPoint(
  pointId: PolicyPointId,
): ReadonlySet<Policy.PolicyEffectType> {
  return new Set(Policy.PolicyPoint.Registry[pointId].allowedEffects);
}

export function isPreBoundary(
  timing: Policy.Timing,
  descriptor: RuntimeResource.Descriptor | undefined,
): boolean {
  const pointId = policyPointIdsForDescriptor(timing, descriptor)[0];
  if (pointId === undefined) return false;
  return Policy.PolicyPoint.Registry[pointId].sideEffectBoundary;
}
