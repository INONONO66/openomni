import type { AgentBudget } from "./types";

export interface BudgetState {
  startTime: number;
  turns: number;
  toolCalls: number;
  toolRuntimeMs: number;
}

export function createBudgetState(): BudgetState {
  return { startTime: Date.now(), turns: 0, toolCalls: 0, toolRuntimeMs: 0 };
}

export function checkBudget(
  state: BudgetState,
  budget?: AgentBudget,
): "ok" | "exceeded" {
  const maxWallTimeMs = budget?.maxWallTimeMs ?? 5 * 60 * 1000;
  const maxTurns = budget?.maxTurns ?? 24;
  const maxToolCalls = budget?.maxToolCalls ?? 40;
  const maxToolRuntimeMs = budget?.maxToolRuntimeMs ?? 2 * 60 * 1000;

  const elapsed = Date.now() - state.startTime;
  if (elapsed >= maxWallTimeMs) return "exceeded";
  if (state.turns >= maxTurns) return "exceeded";
  if (state.toolCalls >= maxToolCalls) return "exceeded";
  if (state.toolRuntimeMs >= maxToolRuntimeMs) return "exceeded";
  return "ok";
}

export function recordTurn(state: BudgetState): BudgetState {
  return { ...state, turns: state.turns + 1 };
}

export function recordToolCall(
  state: BudgetState,
  durationMs: number,
): BudgetState {
  return {
    ...state,
    toolCalls: state.toolCalls + 1,
    toolRuntimeMs: state.toolRuntimeMs + durationMs,
  };
}
