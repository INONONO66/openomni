import type { Policy } from "@openomni/protocol";
import type { GenericPolicyContext, PolicyRegistrationGeneric } from "./engine-types";

function matchesTiming<TCtx extends GenericPolicyContext>(
  reg: PolicyRegistrationGeneric<TCtx>,
  timing: Policy.Timing,
): boolean {
  return Array.isArray(reg.timing) ? reg.timing.includes(timing) : reg.timing === timing;
}

function matchesScope<TCtx extends GenericPolicyContext>(
  reg: PolicyRegistrationGeneric<TCtx>,
  agentType: string | undefined,
): boolean {
  const allowed = reg.scope?.agentType;
  if (!allowed || allowed.length === 0) return true;
  if (!agentType) return false;
  return allowed.includes(agentType);
}

export function selectRegistrations<TCtx extends GenericPolicyContext>(
  registrations: readonly PolicyRegistrationGeneric<TCtx>[],
  timing: Policy.Timing,
  agentType: string | undefined,
): PolicyRegistrationGeneric<TCtx>[] {
  return registrations
    .map((reg, index) => ({ index, reg }))
    .filter(({ reg }) => matchesTiming(reg, timing) && matchesScope(reg, agentType))
    .sort((a, b) => a.reg.priority - b.reg.priority || a.index - b.index)
    .map(({ reg }) => reg);
}
