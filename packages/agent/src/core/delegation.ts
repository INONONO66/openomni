export type DelegationContext = {
  depth: number;
  maxDepth: number;
  visitedAgents: Set<string>;
  parentAbort: AbortSignal;
  budgetPolicy: "inherit" | "independent";
};

export function checkDelegation(
  agentName: string,
  context: DelegationContext,
): "allow" | "depth_exceeded" | "circular_detected" {
  if (context.visitedAgents.has(agentName)) return "circular_detected";
  if (context.depth >= context.maxDepth) return "depth_exceeded";
  return "allow";
}
