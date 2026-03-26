/**
 * Configuration for concurrency control
 */
export interface ConcurrencyConfig {
  maxRunning: number;
  mode: "queue" | "drop";
}

/**
 * ConcurrencyGate namespace providing utilities for managing task concurrency
 */
export namespace ConcurrencyGate {
  // In-memory tracking for gate statistics
  let stats = {
    allowed: 0,
    queued: 0,
    dropped: 0,
  };

  /**
   * Checks if a task can run based on current running count and configuration
   * @param taskId - The ID of the task to check
   * @param runningCount - Current number of running tasks
   * @param config - Concurrency configuration
   * @returns Decision: 'allow', 'queue', or 'drop'
   */
  export function check(
    _taskId: string,
    runningCount: number,
    config: ConcurrencyConfig,
  ): "allow" | "queue" | "drop" {
    if (runningCount < config.maxRunning) {
      return "allow";
    }

    // At or above maxRunning limit
    if (config.mode === "queue") {
      return "queue";
    } else {
      return "drop";
    }
  }

  /**
   * Returns current gate statistics
   * @returns Object with allowed, queued, and dropped counts
   */
  export function getStatus(): {
    allowed: number;
    queued: number;
    dropped: number;
  } {
    return { ...stats };
  }

  /**
   * Records a decision for metrics tracking
   * @param taskId - The ID of the task
   * @param decision - The decision made: 'allow', 'queue', or 'drop'
   */
  export function record(_taskId: string, decision: "allow" | "queue" | "drop"): void {
    if (decision === "allow") {
      stats.allowed++;
    } else if (decision === "queue") {
      stats.queued++;
    } else if (decision === "drop") {
      stats.dropped++;
    }
  }

  /**
   * Resets statistics (useful for testing)
   */
  export function resetStats(): void {
    stats = {
      allowed: 0,
      queued: 0,
      dropped: 0,
    };
  }
}

export type PermissionLevel = "ask" | "notify" | "deny";

export interface PermissionDecision {
  level: PermissionLevel;
  reason?: string;
}

export interface PermissionContext {
  taskPolicy?: PermissionLevel;
  agentPolicy?: PermissionLevel;
  systemDefault: PermissionLevel;
}

export namespace PermissionGate {
  export function evaluate(context: PermissionContext): PermissionDecision {
    const { taskPolicy, agentPolicy, systemDefault } = context;

    if (taskPolicy !== undefined) {
      return {
        level: taskPolicy,
        reason: "Selected from task policy",
      };
    }

    if (agentPolicy !== undefined) {
      return {
        level: agentPolicy,
        reason: "Selected from agent policy",
      };
    }

    return {
      level: systemDefault,
      reason: "Selected from system default",
    };
  }
}

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
  export function checkBudget(state: RunState, budget: RunBudget): BudgetStatus {
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
  export function recordToolCall(state: RunState, durationMs: number): RunState {
    return {
      ...state,
      toolCalls: state.toolCalls + 1,
      toolRuntimeMs: state.toolRuntimeMs + durationMs,
    };
  }
}
