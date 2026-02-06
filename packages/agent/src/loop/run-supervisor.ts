/**
 * Budget configuration for agent run limits
 */
export interface RunBudget {
  maxWallTimeMs: number;
  maxTurns: number;
  maxToolCalls: number;
  maxToolRuntimeMs: number;
}

/**
 * Current state of an agent run
 */
export interface RunState {
  startTime: number;
  turns: number;
  toolCalls: number;
  toolRuntimeMs: number;
}

/**
 * Status indicating whether budget constraints are met
 */
export type BudgetStatus = "ok" | "exceeded";

/**
 * RunSupervisor namespace providing utilities for managing agent run budgets
 */
export namespace RunSupervisor {
  /**
   * Creates an initial run state with current timestamp
   * @returns Fresh RunState with zero counters
   */
  export function createState(): RunState {
    return {
      startTime: Date.now(),
      turns: 0,
      toolCalls: 0,
      toolRuntimeMs: 0,
    };
  }

  /**
   * Checks if any budget constraint has been exceeded
   * @param state - Current run state
   * @param budget - Budget limits to check against
   * @returns 'ok' if within budget, 'exceeded' if any limit is breached
   */
  export function checkBudget(
    state: RunState,
    budget: RunBudget,
  ): BudgetStatus {
    const elapsed = Date.now() - state.startTime;

    if (elapsed >= budget.maxWallTimeMs) {
      return "exceeded";
    }

    if (state.turns >= budget.maxTurns) {
      return "exceeded";
    }

    if (state.toolCalls >= budget.maxToolCalls) {
      return "exceeded";
    }

    if (state.toolRuntimeMs >= budget.maxToolRuntimeMs) {
      return "exceeded";
    }

    return "ok";
  }

  /**
   * Records a completed turn, incrementing the turn counter
   * @param state - Current run state
   * @returns New state with incremented turn count
   */
  export function recordTurn(state: RunState): RunState {
    return {
      ...state,
      turns: state.turns + 1,
    };
  }

  /**
   * Records a completed tool call with its duration
   * @param state - Current run state
   * @param durationMs - Duration of the tool call in milliseconds
   * @returns New state with incremented tool call count and runtime
   */
  export function recordToolCall(
    state: RunState,
    durationMs: number,
  ): RunState {
    return {
      ...state,
      toolCalls: state.toolCalls + 1,
      toolRuntimeMs: state.toolRuntimeMs + durationMs,
    };
  }
}
