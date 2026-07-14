import { Policy } from "@openomni/protocol";
import type {
  AuditDispatchContextGeneric,
  PolicyEngineCompatibilityGeneric,
  PolicyPointId,
} from "@openomni/policy";
import type { PolicyContext } from "./types";

function matchingPoint(
  candidates: readonly PolicyPointId[],
  segment: ".native." | ".mcp." | "delegation.worker.",
): PolicyPointId | undefined {
  return candidates.find((pointId) => pointId.includes(segment));
}

function isMcpContext(ctx: Readonly<AuditDispatchContextGeneric<PolicyContext>>): boolean {
  const descriptor = ctx.resourceDescriptor;
  if (descriptor !== undefined) {
    const source = descriptor.source?.type;
    return source === "mcp" || source === "skill-mcp";
  }
  return ctx.toolLabels?.some((label) => /^source[.:](mcp|skill-mcp)$/.test(label)) ?? false;
}

function resolveLegacyPoint(
  timing: Policy.Timing,
  ctx: Readonly<AuditDispatchContextGeneric<PolicyContext>>,
): PolicyPointId | undefined {
  const candidates = Policy.PolicyPoint.resolve(timing);
  if (candidates.length === 1) return candidates[0];

  const descriptor = ctx.resourceDescriptor;
  if (descriptor?.kind === "worker") return matchingPoint(candidates, "delegation.worker.");
  if (descriptor !== undefined && descriptor.kind !== "tool") return undefined;
  if (descriptor === undefined && ctx.toolName === undefined) return undefined;
  if (isMcpContext(ctx)) return matchingPoint(candidates, ".mcp.");
  if (descriptor?.source !== undefined || ctx.toolName !== undefined) {
    return matchingPoint(candidates, ".native.");
  }
  return undefined;
}

export const agentPolicyCompatibility = {
  includeLegacyAtPoint: true,
  resolvePointForLegacyDispatch: resolveLegacyPoint,
} satisfies PolicyEngineCompatibilityGeneric<PolicyContext>;
