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
  export function record(
    _taskId: string,
    decision: "allow" | "queue" | "drop",
  ): void {
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
