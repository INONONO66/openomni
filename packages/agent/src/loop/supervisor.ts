export interface RunBudget {
  maxWallTimeMs: number;
  maxTurns: number;
  maxToolCalls: number;
}

export interface RunState {
  startTime: number;
  turnCount: number;
  toolCallCount: number;
  aborted: boolean;
}

export type BudgetViolation = "wall_time" | "turns" | "tool_calls";

export namespace RunSupervisor {
  export function create(_budget: RunBudget): RunState {
    return {
      startTime: Date.now(),
      turnCount: 0,
      toolCallCount: 0,
      aborted: false,
    };
  }

  export function checkBudget(
    state: RunState,
    budget: RunBudget,
  ): BudgetViolation | null {
    if (state.aborted) {
      return null;
    }

    const elapsed = Date.now() - state.startTime;
    if (elapsed >= budget.maxWallTimeMs) {
      return "wall_time";
    }

    if (state.turnCount >= budget.maxTurns) {
      return "turns";
    }

    if (state.toolCallCount >= budget.maxToolCalls) {
      return "tool_calls";
    }

    return null;
  }

  export function incrementTurn(state: RunState): void {
    state.turnCount++;
  }

  export function incrementToolCall(state: RunState): void {
    state.toolCallCount++;
  }

  export function abort(state: RunState): void {
    state.aborted = true;
  }
}
