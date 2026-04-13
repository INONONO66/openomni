import type { AgentBudget } from "./types";

export interface BudgetState {
  startTime: number;
  turns: number;
  toolCalls: number;
  toolRuntimeMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export function createBudgetState(): BudgetState {
  return {
    startTime: Date.now(),
    turns: 0,
    toolCalls: 0,
    toolRuntimeMs: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
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

  if (maxWallTimeMs !== -1 && elapsed >= maxWallTimeMs) return "exceeded";
  if (maxTurns !== -1 && state.turns >= maxTurns) return "exceeded";
  if (maxToolCalls !== -1 && state.toolCalls >= maxToolCalls) return "exceeded";
  if (maxToolRuntimeMs !== -1 && state.toolRuntimeMs >= maxToolRuntimeMs) return "exceeded";

  const ratios: number[] = [];
  if (maxWallTimeMs !== -1) ratios.push(elapsed / maxWallTimeMs);
  if (maxTurns !== -1) ratios.push(state.turns / maxTurns);
  if (maxToolCalls !== -1) ratios.push(state.toolCalls / maxToolCalls);
  if (maxToolRuntimeMs !== -1) ratios.push(state.toolRuntimeMs / maxToolRuntimeMs);

  if (ratios.length === 0) return "ok";

  const maxRatio = Math.max(...ratios);

  if (maxRatio >= warningRatio) return "warning";
  if (maxRatio >= reassuranceRatio) return "reassurance";
  return "ok";
}

export function describeBudgetRemaining(state: BudgetState, budget?: AgentBudget): string {
  const parts: string[] = [];
  const maxTurns = budget?.maxTurns ?? 24;
  if (maxTurns === -1) {
    parts.push("unlimited turns remaining");
  } else {
    const remainingTurns = maxTurns - state.turns;
    parts.push(`${remainingTurns} turn${remainingTurns !== 1 ? "s" : ""} remaining`);
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
): BudgetState {
  return {
    ...state,
    totalInputTokens: state.totalInputTokens + inputTokens,
    totalOutputTokens: state.totalOutputTokens + outputTokens,
  };
}
