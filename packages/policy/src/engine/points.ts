import { Policy, type RuntimeResource } from "@openomni/protocol";
import type { PolicyPointId } from "./types";

export function policyPointIdsForDescriptor(
  timing: Policy.Timing,
  descriptor: RuntimeResource.Descriptor | undefined,
): PolicyPointId[] {
  const aliases = Policy.PolicyPoint.MigrationMapping[timing];
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

export function isPreBoundary(
  timing: Policy.Timing,
  descriptor: RuntimeResource.Descriptor | undefined,
): boolean {
  const pointId = policyPointIdsForDescriptor(timing, descriptor)[0];
  if (pointId === undefined) return false;
  return Policy.PolicyPoint.Registry[pointId].sideEffectBoundary;
}
