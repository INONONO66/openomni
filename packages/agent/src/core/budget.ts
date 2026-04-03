import type { AgentBudget } from "./types";

export interface BudgetState {
  startTime: number;
  turns: number;
  toolCalls: number;
  toolRuntimeMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
}

export function createBudgetState(): BudgetState {
  return {
    startTime: Date.now(),
    turns: 0,
    toolCalls: 0,
    toolRuntimeMs: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
  };
}

export function checkBudget(
  state: BudgetState,
  budget?: AgentBudget,
): "ok" | "reassurance" | "warning" | "exceeded" {
  const maxWallTimeMs = budget?.maxWallTimeMs ?? 5 * 60 * 1000;
  const maxTurns = budget?.maxTurns ?? 24;
  const maxToolCalls = budget?.maxToolCalls ?? 40;
  const maxToolRuntimeMs = budget?.maxToolRuntimeMs ?? 2 * 60 * 1000;
  const warningRatio = budget?.warningThreshold ?? 0.8;
  const reassuranceRatio = budget?.reassuranceThreshold ?? 0.6;

  const elapsed = Date.now() - state.startTime;

  if (elapsed >= maxWallTimeMs) return "exceeded";
  if (state.turns >= maxTurns) return "exceeded";
  if (state.toolCalls >= maxToolCalls) return "exceeded";
  if (state.toolRuntimeMs >= maxToolRuntimeMs) return "exceeded";

  if (budget?.maxInputTokens !== undefined && state.totalInputTokens >= budget.maxInputTokens)
    return "exceeded";
  if (budget?.maxOutputTokens !== undefined && state.totalOutputTokens >= budget.maxOutputTokens)
    return "exceeded";
  if (
    budget?.maxTotalTokens !== undefined &&
    state.totalInputTokens + state.totalOutputTokens >= budget.maxTotalTokens
  )
    return "exceeded";
  if (budget?.maxCost !== undefined && state.totalCost >= budget.maxCost) return "exceeded";

  const ratios: number[] = [
    elapsed / maxWallTimeMs,
    state.turns / maxTurns,
    state.toolCalls / maxToolCalls,
    state.toolRuntimeMs / maxToolRuntimeMs,
  ];
  if (budget?.maxCost !== undefined) ratios.push(state.totalCost / budget.maxCost);
  if (budget?.maxTotalTokens !== undefined)
    ratios.push((state.totalInputTokens + state.totalOutputTokens) / budget.maxTotalTokens);
  if (budget?.maxInputTokens !== undefined)
    ratios.push(state.totalInputTokens / budget.maxInputTokens);
  if (budget?.maxOutputTokens !== undefined)
    ratios.push(state.totalOutputTokens / budget.maxOutputTokens);

  const maxRatio = Math.max(...ratios);

  if (maxRatio >= warningRatio) return "warning";
  if (maxRatio >= reassuranceRatio) return "reassurance";
  return "ok";
}

export function describeBudgetRemaining(state: BudgetState, budget?: AgentBudget): string {
  const parts: string[] = [];
  const maxTurns = budget?.maxTurns ?? 24;
  const remainingTurns = maxTurns - state.turns;
  parts.push(`${remainingTurns} turn${remainingTurns !== 1 ? "s" : ""} remaining`);
  if (budget?.maxCost !== undefined) {
    const remaining = (budget.maxCost - state.totalCost).toFixed(4);
    parts.push(`$${remaining} budget remaining`);
  }
  return parts.join(", ");
}

export function recordTurn(state: BudgetState): BudgetState {
  return { ...state, turns: state.turns + 1 };
}

export function recordToolCall(state: BudgetState, durationMs: number): BudgetState {
  return {
    ...state,
    toolCalls: state.toolCalls + 1,
    toolRuntimeMs: state.toolRuntimeMs + durationMs,
  };
}

export function recordTokenUsage(
  state: BudgetState,
  inputTokens: number,
  outputTokens: number,
  cost: number,
): BudgetState {
  return {
    ...state,
    totalInputTokens: state.totalInputTokens + inputTokens,
    totalOutputTokens: state.totalOutputTokens + outputTokens,
    totalCost: state.totalCost + cost,
  };
}
