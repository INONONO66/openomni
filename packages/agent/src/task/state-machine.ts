import type { Task } from "./types";

/**
 * Task State Machine
 * Implements spec section 3.4: Task Status & State Machine
 *
 * Manages valid state transitions and auto-reset logic for recurring tasks.
 */

/**
 * Valid state transitions map
 * Key: from state, Value: array of allowed to states
 */
const VALID_TRANSITIONS: Record<Task.Status, Task.Status[]> = {
  idle: ["scheduled"],
  scheduled: ["running", "cancelled"],
  running: ["done", "failed", "cancelled", "blocked"],
  blocked: ["running", "cancelled"],
  done: ["idle"], // Auto-reset for recurring tasks
  failed: ["idle"], // Auto-reset for recurring tasks
  cancelled: ["idle"], // Auto-reset for recurring tasks
};

/**
 * Terminal states that trigger auto-reset for recurring tasks
 */
const TERMINAL_STATES: Task.Status[] = ["done", "failed", "cancelled"];

/**
 * TaskStateMachine - Validates state transitions and manages task status
 */
export class TaskStateMachine {
  /**
   * Validates if a state transition is allowed
   *
   * @param from - Current status
   * @param to - Target status
   * @returns true if transition is valid, false otherwise
   */
  static validateTransition(from: Task.Status, to: Task.Status): boolean {
    const allowedStates = VALID_TRANSITIONS[from];
    return allowedStates?.includes(to) ?? false;
  }

  /**
   * Checks if a status is a terminal state
   *
   * @param status - Status to check
   * @returns true if status is terminal (done/failed/cancelled)
   */
  static isTerminalState(status: Task.Status): boolean {
    return TERMINAL_STATES.includes(status);
  }

  /**
   * Determines if a task should auto-reset to idle after reaching terminal state
   *
   * @param task - Task info
   * @returns true if task should auto-reset (recurring/hybrid tasks)
   */
  static shouldAutoReset(task: Task.Info): boolean {
    // One-time tasks: triggers: [{ type: "once" }] or no triggers
    if (!task.triggers || task.triggers.length === 0) {
      return false;
    }

    // If all triggers are "once", it's a one-time task
    const allOnce = task.triggers.every((t) => t.type === "once");
    if (allOnce) {
      return false;
    }

    // Has recurring triggers (cron, interval, event) or manual
    return true;
  }

  /**
   * Derives task status from current/last Task.Run state
   *
   * @param task - Task info
   * @param pendingRun - Current pending/active run (if any)
   * @param lastRun - Last completed run (if any)
   * @returns Derived task status
   */
  static deriveStatus(
    task: Task.Info,
    pendingRun?: Task.Run,
    lastRun?: Task.Run,
  ): Task.Status {
    // If there's a pending/active run, use its status
    if (pendingRun) {
      const runStatus = pendingRun.status;
      // Map Task.Run status to Task status
      if (
        runStatus === "scheduled" ||
        runStatus === "running" ||
        runStatus === "blocked"
      ) {
        return runStatus;
      }
    }

    // If last run is in terminal state
    if (lastRun) {
      const runStatus = lastRun.status;
      if (
        runStatus === "done" ||
        runStatus === "failed" ||
        runStatus === "cancelled"
      ) {
        // Auto-reset to idle for recurring tasks
        if (this.shouldAutoReset(task)) {
          return "idle";
        }
        // Keep terminal state for one-time tasks
        return runStatus;
      }
    }

    // Default: idle (no runs or eligible for new triggers)
    return "idle";
  }

  /**
   * Applies a status transition with validation
   *
   * @param task - Task to update
   * @param newStatus - Target status
   * @throws Error if transition is invalid
   * @returns Updated task with new status
   */
  static applyTransition(task: Task.Info, newStatus: Task.Status): Task.Info {
    const currentStatus = task.status;

    // Validate transition
    if (!this.validateTransition(currentStatus, newStatus)) {
      throw new Error(
        `Invalid state transition: ${currentStatus} -> ${newStatus}`,
      );
    }

    // Apply transition
    const updatedTask: Task.Info = {
      ...task,
      status: newStatus,
      updatedAt: Date.now(),
    };

    // Auto-reset to idle if terminal state and recurring task
    if (this.isTerminalState(newStatus) && this.shouldAutoReset(task)) {
      updatedTask.status = "idle";
    }

    return updatedTask;
  }

  /**
   * Gets all valid next states from current state
   *
   * @param from - Current status
   * @returns Array of valid next states
   */
  static getValidNextStates(from: Task.Status): Task.Status[] {
    return VALID_TRANSITIONS[from] ?? [];
  }
}

/**
 * TaskManager - High-level task status management
 */
export class TaskStatusManager {
  /**
   * Manually sets task status with validation
   * Used for manual overrides (e.g., admin actions, manual reset)
   *
   * @param task - Task to update
   * @param newStatus - Target status
   * @throws Error if transition is invalid
   * @returns Updated task
   */
  static setStatus(task: Task.Info, newStatus: Task.Status): Task.Info {
    return TaskStateMachine.applyTransition(task, newStatus);
  }

  /**
   * Updates task status based on Task.Run state changes
   *
   * @param task - Task to update
   * @param pendingRun - Current pending/active run
   * @param lastRun - Last completed run
   * @returns Updated task with derived status
   */
  static updateFromRun(
    task: Task.Info,
    pendingRun?: Task.Run,
    lastRun?: Task.Run,
  ): Task.Info {
    const derivedStatus = TaskStateMachine.deriveStatus(
      task,
      pendingRun,
      lastRun,
    );

    return {
      ...task,
      status: derivedStatus,
      updatedAt: Date.now(),
      pendingRun,
      lastRun,
    };
  }
}
