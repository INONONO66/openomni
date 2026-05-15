import type { Policy } from "@openomni/protocol";

export function effectOf<T extends Policy.PolicyEffect["type"]>(
  decision: Policy.PolicyDecision,
  type: T,
): Extract<Policy.PolicyEffect, { type: T }> | undefined {
  return decision.effects.find(
    (effect): effect is Extract<Policy.PolicyEffect, { type: T }> => effect.type === type,
  );
}

export function effectsOf<T extends Policy.PolicyEffect["type"]>(
  decision: Policy.PolicyDecision,
  type: T,
): Array<Extract<Policy.PolicyEffect, { type: T }>> {
  return decision.effects.filter(
    (effect): effect is Extract<Policy.PolicyEffect, { type: T }> => effect.type === type,
  );
}

export function matchesToolPattern(toolName: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return toolName.startsWith(`${pattern.slice(0, -2)}.`);
  return toolName === pattern;
}
