import type { Policy } from "@openomni/protocol";
import type { PolicyRegistration } from "./types";

function matchesTiming(reg: PolicyRegistration, timing: Policy.Timing): boolean {
  return Array.isArray(reg.timing) ? reg.timing.includes(timing) : reg.timing === timing;
}

function matchesScope(reg: PolicyRegistration, agentType: string | undefined): boolean {
  const allowed = reg.scope?.agentType;
  if (!allowed || allowed.length === 0) return true;
  if (!agentType) return false;
  return allowed.includes(agentType);
}

export function selectRegistrations(
  registrations: readonly PolicyRegistration[],
  timing: Policy.Timing,
  agentType: string | undefined,
): PolicyRegistration[] {
  return registrations
    .map((reg, index) => ({ index, reg }))
    .filter(({ reg }) => matchesTiming(reg, timing) && matchesScope(reg, agentType))
    .sort((a, b) => a.reg.priority - b.reg.priority || a.index - b.index)
    .map(({ reg }) => reg);
}
