import type { BudgetState } from "./budget";
import type { AgentBudget } from "./types";

export type DelegationContext = {
  depth: number;
  maxDepth: number;
  visitedAgents: Set<string>;
  parentAbort: AbortSignal;
  budgetPolicy: "inherit" | "independent" | "split";
  budgetAllocation?: number;
  reserveForParent?: number;
  parentBudgetState?: BudgetState;
  parentBudget?: AgentBudget;
};

export function allocateBudget(
  parentState: BudgetState,
  parentBudget: AgentBudget | undefined,
  context: Pick<DelegationContext, "budgetPolicy" | "budgetAllocation" | "reserveForParent">,
): AgentBudget {
  const policy = context.budgetPolicy;

  if (policy === "independent") {
    return { maxTurns: 10, maxToolCalls: 20 };
  }

  const maxTurns = parentBudget?.maxTurns ?? 24;
  const remainingTurns = maxTurns - parentState.turns;

  if (policy === "inherit") {
    return {
      ...parentBudget,
      maxTurns: Math.max(1, remainingTurns),
      maxCost:
        parentBudget?.maxCost !== undefined
          ? Math.max(0, parentBudget.maxCost - parentState.totalCost)
          : undefined,
    };
  }

  const allocation = context.budgetAllocation ?? 0.5;
  const reserve = context.reserveForParent ?? 0.2;
  const factor = (1 - reserve) * allocation;

  return {
    ...parentBudget,
    maxTurns: Math.max(1, Math.floor(remainingTurns * factor)),
    maxCost:
      parentBudget?.maxCost !== undefined
        ? Math.max(0, (parentBudget.maxCost - parentState.totalCost) * factor)
        : undefined,
  };
}

export function checkDelegation(
  agentName: string,
  context: DelegationContext,
): "allow" | "depth_exceeded" | "circular_detected" {
  if (context.visitedAgents.has(agentName)) return "circular_detected";
  if (context.depth >= context.maxDepth) return "depth_exceeded";
  return "allow";
}
